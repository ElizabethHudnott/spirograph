'use strict';
document.getElementById('site-url').innerHTML = document.location.origin;
filePath = rootPath + 'sketch/';
const urlParameters = new URLSearchParams(document.location.search);
let bgGenerator, generateBackground, setBgProperty, setBgPropertyElement;
let random = new RandomNumberGenerator();
const bgGeneratorImage = new Image();
let backgroundImage;

if (!globalThis.debug) {
	globalThis.debug = {};
}
debug.video = false;
debug.htmlChecks = document.location.hostname === 'localhost';

let store;
try {
	store = window.localStorage;
} catch (e) {
	console.warn('Local storage unavailable.');
}

let unitsProcessed, yieldTime, benchmark;

const redrawInterval = 1000 / 30;

function calcBenchmark() {
	const now = performance.now();
	benchmark = Math.trunc(unitsProcessed / Math.max(now - yieldTime + redrawInterval, 1) * redrawInterval);
	return now;
}

function hasRandomness(enabled) {
	document.getElementById('generate-btn-group').hidden = !enabled;
}

{
	const backendRoot = 'http://localhost/';
	const backgroundElement = document.body;
	if (darkMode()) {
		document.getElementById('background-color').value = '#000000';
		backgroundElement.style.backgroundColor = '#000000';
	}

	let backgroundRedraw;
	let rotation = 0, opacity = 1;

	const ScaleMode = Object.freeze({
		CONTAIN: 0,
		VIEWPORT: 1,
		COVER: 2,
	});
	let scale = 1, scaleMode = ScaleMode.VIEWPORT;
	let blur = 0.4;	// No blur

	const canvas = document.getElementById('background-canvas');

	const vertexShaderSource = `#version 300 es
 		in vec4 aVertexPosition;
		uniform mat4 uModelViewMatrix;
		uniform mat4 uProjectionMatrix;

		void main() {
			gl_Position = uProjectionMatrix * uModelViewMatrix * aVertexPosition;
		}
	`;

	const fragmentShaderHeader = `#version 300 es
		precision highp float;
		precision highp int;
		out vec4 fragColor;
		#define PI ${Math.PI}
		#define SQRT2 ${Math.SQRT2}
		uniform float canvasWidth;
		uniform float canvasHeight;
		uniform float tween;
		uniform int preview;

		vec4 hsla(in float h, in float s, in float l, in float a) {
			vec3 rgb = clamp(
				abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
				0.0, 1.0
			);
			return vec4(l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0)), a);
		}
	`;

	function loadShader(context, type, source) {
		const shader = context.createShader(type);
		context.shaderSource(shader, source);
		context.compileShader(shader);

		if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
			console.error('Unable to compile shader: ' + context.getShaderInfoLog(shader));
			context.deleteShader(shader);
			const sourceLines = source.split('\n');
			let annotatedLines = ''
			for (let i = 0; i < sourceLines.length; i++) {
				annotatedLines += String(i + 1) + '\t' + sourceLines[i] + '\n';
			}
			console.log(annotatedLines);
			return null;
		}

		return shader;
	}

	const GLTypeCategory = Object.freeze({
		'SCALAR': 0,
		'VECTOR': 1,
		'MATRIX': 2,
	});

	class GLType {
		constructor(category, baseType, width, height, length) {
			this.category = category;
			this.baseType = baseType;
			this.width = width;
			this.height = height;
			this.length = length;

			const setterBaseType = baseType === 'b' ? 'f' : baseType;
			if (category === GLTypeCategory.SCALAR && length === undefined) {
				this.setterName = 'uniform1' + setterBaseType;
			} else if (category === GLTypeCategory.MATRIX) {
				if (width === height) {
					this.setterName = 'uniformMatrix' + width + 'fv';
				} else {
					this.setterName = 'uniformMatrix' + height + 'x' + width + 'fv';
				}
			} else {
				this.setterName = 'uniform' + width + setterBaseType + 'v'
			}
		}

		toString() {
			let category = this.category;
			if (category === GLTypeCategory.VECTOR && this.width === 1) {
				category = GLTypeCategory.SCALAR;
			}
			let typeName;
			switch (category) {
			case GLTypeCategory.SCALAR:
				switch (this.baseType) {
				case 'b':
					typeName = 'bool';
					break;
				case 'i':
					typeName = 'int';
					break;
				case 'f':
					typeName = 'float';
					break;
				}
				break;
			case GLTypeCategory.VECTOR:
				typeName = (this.baseType === 'f' ? 'vec' : this.baseType + 'vec') + this.width;
				break;
			case GLTypeCategory.MATRIX:
				typeName = 'mat' + this.height + 'x' + this.width;
				break;
			}
			if (this.length !== undefined) {
				typeName += '[' + this.length + ']';
			}
			return typeName;
		}

		assignValue(gl, location, value) {
			const category = this.category;
			const isArray = this.length !== undefined;
			if (isArray) {
				value = [].concat(...value); // Flatten
			}
			if (category === GLTypeCategory.MATRIX) {
				value = new Float32Array([].concat(...value));
				gl[this.setterName](location, false, value);
			} else {
				if (
					this.baseType === 'i' &&
					(category === GLTypeCategory.VECTOR || isArray)
				) {
					value = new Int32Array(value);
				}
				gl[this.setterName](location, value);
			}
		}

	}

	const glTypes = new Map();
	glTypes.set('b', new GLType(GLTypeCategory.SCALAR, 'b'));
	glTypes.set('i', new GLType(GLTypeCategory.SCALAR, 'i'));
	glTypes.set('f', new GLType(GLTypeCategory.SCALAR, 'f'));
	for (let i = 1; i <= 4; i++) {
		glTypes.set('bvec' + i, new GLType(GLTypeCategory.VECTOR, 'b', i));
		glTypes.set('ivec' + i, new GLType(GLTypeCategory.VECTOR, 'i', i));
		glTypes.set('fvec' + i, new GLType(GLTypeCategory.VECTOR, 'f', i));
	}

	function glBaseType(example, isInteger) {
		if (isInteger) {
			if (example === true || example === false) {
				return 'b';
			} else {
				return 'i';
			}
		} else {
			return 'f';
		}
	}

	function inferGLType(example, isInteger) {

		if (Array.isArray(example)) {
			const dim1 = example.length;

			if (Array.isArray(example[0])) {
				const dim2 = example[0].length;

				if (Array.isArray(example[0][0])) {
					const dim3 = example[0][0].length;
					// Array of matrices
					return new GLType(GLTypeCategory.MATRIX, 'f', dim3, dim2, dim1);
				} else if (!isInteger && dim1 > 1 && dim1 < 5 && dim2 > 1 && dim2 < 5) {
					// Matrix
					return new GLType(GLTypeCategory.MATRIX, 'f', dim2, dim1);
				} else {
					// Array of vectors
					return new GLType(GLTypeCategory.VECTOR, glBaseType(example[0][0], isInteger), dim2, 1, dim1);
				}
			} else if (dim1 < 5) {
				// Vector
				return glTypes.get(glBaseType(example[0], isInteger) + 'vec' + dim1);
			} else {
				// Array of scalars
				return new GLType(GLTypeCategory.SCALAR, glBaseType(example[0], isInteger), 1, 1, dim1);
			}
		} else {
			return glTypes.get(glBaseType(example, isInteger));
		}
	}

	function shaderDeclarations(generator) {
		let str = '';
		const animatable = generator.animatable;
		if (animatable !== undefined) {
			const continuous = animatable.continuous;
			if (continuous !== undefined) {
				for (let property of continuous) {
					const value = generator[property];
					const typeName = inferGLType(value, false).toString();
					str += 'uniform ' + typeName + ' ' + property + ';\n';
				}
			}
			const stepped = animatable.stepped;
			if (stepped !== undefined) {
				for (let property of stepped) {
					const value = generator[property];
					const typeName = inferGLType(value, true).toString();
					str += 'uniform ' + typeName + ' ' + property + ';\n';
				}
			}
			const nominalArray = animatable.nominalArray;
			if (nominalArray !== undefined) {
				for (let property of nominalArray) {
					const value = generator[property];
					const typeName = inferGLType(value, true).toString();
					str += 'uniform ' + typeName + ' ' + property + ';\n';
				}
			}

			const pairedContinuous = animatable.pairedContinuous;
			if (pairedContinuous !== undefined) {
				for (let [property1, property2] of pairedContinuous) {
					const value1 = generator[property1];
					const typeName = inferGLType(value1, false).toString();
					str += 'uniform ' + typeName + ' ' + property1 + ';\n';
					str += 'uniform ' + typeName + ' ' + property2 + ';\n';
				}
			}
			const xy = animatable.xy;
			if (xy !== undefined) {
				for (let [property1, property2] of xy) {
					str += 'uniform float ' + property1 + ';\n';
					str += 'uniform float ' + property2 + ';\n';
				}

			}
			const pairedStepped = animatable.pairedStepped;
			if (pairedStepped !== undefined) {
				for (let [property1, property2] of pairedStepped) {
					const value1 = generator[property1];
					const typeName = inferGLType(value1, true).toString();
					str += 'uniform ' + typeName + ' ' + property1 + ';\n';
					str += 'uniform ' + typeName + ' ' + property2 + ';\n';
				}
			}
		}
		return str;
	}

	class DrawingContext {
		constructor(canvas, width, height, scale, svg) {
			const twoD = canvas.getContext('2d');
			this.twoD = twoD;
			this.gl = undefined;
			this.scale = scale;
			this.svg = svg;
			this.twoDMatrixInv = new DOMMatrix([scale, 0, 0, scale, 0, 0]);
			this.resize(width, height);
			this.modelViewMatrix = undefined;
			this.projectionMatrix = undefined;
			this.uniformLocations = undefined;
			this.program = undefined;
			this.types = undefined;
			this.webglInitialized = false;
		}

		resize(width, height) {
			const canvas = this.twoD.canvas;
			canvas.width = width;
			canvas.height = height;
			const twoD = this.twoD;
			const scale = this.scale;
			if (scale !== 1) {
				twoD.scale(scale, scale);
				twoD.save();
			}
			twoD.save();
			const svg = this.svg;
			if (svg !== undefined) {
				svg.setAttribute('width', width);
				svg.setAttribute('height', height);
			}

			const gl = this.gl;
			if (gl !== undefined) {
				const glCanvas = gl.canvas;
				glCanvas.width = width / scale;
				glCanvas.height = height / scale;
				gl.viewport(0, 0, glCanvas.width, glCanvas.height);

				const fieldOfView = Math.PI / 4;
				const aspect = width / height;
				const zNear = 0.1;
				const zFar = 100;
				const projectionMatrix = mat4.create();
				mat4.perspective(projectionMatrix, fieldOfView, aspect, zNear, zFar);
				this.projectionMatrix = projectionMatrix;

				if (this.webglInitialized) {
					const uniformLocations = this.uniformLocations;
					gl.uniformMatrix4fv(
						uniformLocations.projectionMatrix,
						false,
						projectionMatrix
					);
					gl.uniform1f(uniformLocations.width, glCanvas.width);
					gl.uniform1f(uniformLocations.height, glCanvas.height);
				}
			}
        }

        save2DMatrix() {
        	const matrix = this.twoD.getTransform();
        	matrix.invertSelf();
        	this.twoDMatrixInv = matrix;
        }

        transform2DPoint(x, y) {
        	const matrix = this.twoDMatrixInv;
			const transformedX = Math.round(matrix.a * x + matrix.c * y + matrix.e);
			const transformedY = Math.round(matrix.b * x + matrix.d * y + matrix.f);
			return [transformedX, transformedY];
        }

		initializeShader(generator) {
			if (!generator.isShader) {
				return;
			}
			let gl = this.gl;
			if (gl === undefined) {
				const glCanvas = document.createElement('CANVAS');
				gl = glCanvas.getContext('webgl2', {premultipliedAlpha : false});
				if (gl === null) {
					throw new Error('The browser or the graphics processor does not support WebGL sketches.');
				}
				this.gl = gl;
				const me = this;
				glCanvas.addEventListener('webglcontextlost', function (event) {
					event.preventDefault();
					me.webglInitialized = false;
				})
			}
			if (!this.webglInitialized) {
				const positionBuffer = gl.createBuffer();
				gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
				const points = [
					-1,  1,
					 1,  1,
					-1, -1,
					 1, -1,
				];
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.STATIC_DRAW);
				gl.enable(gl.DEPTH_TEST);
				const modelViewMatrix = mat4.create();
				mat4.translate(
					modelViewMatrix,	// destination matrix
					modelViewMatrix,	// matrix to translate
					[0, 0, -1]			// amount to translate
				);
				this.modelViewMatrix = modelViewMatrix;
				const twoDCanvas = this.twoD.canvas;
				this.resize(twoDCanvas.width, twoDCanvas.height);
				this.webglInitialized = true;
			}

			const vertexShader = loadShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
			const fragmentShader = loadShader(gl, gl.FRAGMENT_SHADER, generator.shaderSource);
			const program = gl.createProgram();
			this.program = program;
			gl.attachShader(program, vertexShader);
			gl.attachShader(program, fragmentShader);
			gl.linkProgram(program);
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
				console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(program));
				return null;
			}

			const vertexPosition = gl.getAttribLocation(program, 'aVertexPosition');
			gl.vertexAttribPointer(vertexPosition, 2, gl.FLOAT, false, 0, 0);
			const uniformLocations = {
				projectionMatrix: gl.getUniformLocation(program, 'uProjectionMatrix'),
				modelViewMatrix: gl.getUniformLocation(program, 'uModelViewMatrix'),
				width: gl.getUniformLocation(program, 'canvasWidth'),
				height: gl.getUniformLocation(program, 'canvasHeight'),
				tween: gl.getUniformLocation(program, 'tween'),
				preview: gl.getUniformLocation(program, 'preview'),
			};
			this.uniformLocations = uniformLocations;
			gl.enableVertexAttribArray(vertexPosition);
			gl.useProgram(program);
			gl.uniformMatrix4fv(
				uniformLocations.projectionMatrix,
				false,
				this.projectionMatrix
			);
			gl.uniformMatrix4fv(
				uniformLocations.modelViewMatrix,
				false,
				this.modelViewMatrix
			);
			gl.uniform1f(uniformLocations.width, gl.canvas.width);
			gl.uniform1f(uniformLocations.height, gl.canvas.height);
		}

		restoreShader(generator) {
			this.initializeShader(generator);
			this.setProperties(generator);
		}

		inferTypes(generator) {
			const types = new Map();
			const animatable = generator.animatable;
			if (animatable !== undefined) {
				const continuous = animatable.continuous;
				if (continuous !== undefined) {
					for (let property of continuous) {
						types.set(property, inferGLType(generator[property], false));
					}
				}
				const stepped = animatable.stepped;
				if (stepped !== undefined) {
					for (let property of stepped) {
						types.set(property, inferGLType(generator[property], true));
					}
				}
				const nominalArray = animatable.nominalArray;
				if (nominalArray !== undefined) {
					for (let property of nominalArray) {
						types.set(property, inferGLType(generator[property], true));
					}
				}

				const pairedContinuous = animatable.pairedContinuous;
				if (pairedContinuous !== undefined) {
					for (let [property1, property2] of pairedContinuous) {
						types.set(property1, inferGLType(generator[property1], false));
						types.set(property2, inferGLType(generator[property2], false));
					}
				}
				const xy = animatable.xy;
				if (xy !== undefined) {
					for (let [property1, property2] of xy) {
						types.set(property1, inferGLType(generator[property1], false));
						types.set(property2, inferGLType(generator[property2], false));
					}
				}
				const pairedStepped = animatable.pairedStepped;
				if (pairedStepped !== undefined) {
					for (let [property1, property2] of pairedStepped) {
						types.set(property1, inferGLType(generator[property1], true));
						types.set(property2, inferGLType(generator[property2], true));
					}
				}
			}
			this.types = types;
		}

		copyTypes(contextualInfo) {
			this.types = contextualInfo.types;
		}

		setProperty(generator, property, value) {
			if (arguments.length === 2) {
				value = generator[property];
			} else {
				generator[property] = value;
			}
			const gl = this.gl;
			const location = gl.getUniformLocation(this.program, property);
			const type = this.types.get(property);
			type.assignValue(gl, location, value);
		}

		setPropertyElement(generator, property, index, value) {
			const arr = generator[property];
			if (arguments.length === 3) {
				value = arr[index];
			} else {
				arr[index] = value;
			}
			const gl = this.gl;
			const type = this.types.get(property);
			if (type.length === undefined) {
				const location = gl.getUniformLocation(this.program, property)
				type.assignValue(gl, location, arr);
			} else {
				const location = gl.getUniformLocation(this.program, property + '[' + index + ']');
				type.assignValue(gl, location, [value]);
			}
		}

		setProperties(generator) {
			const gl = this.gl;
			const program = this.program;
			const types = this.types;
			for (let property of types.keys()) {
				const location = gl.getUniformLocation(program, property);
				const type = types.get(property);
				type.assignValue(gl, location, generator[property]);
			}
		}

		drawGL(tween, preview) {
			const gl = this.gl;
			gl.uniform1f(this.uniformLocations.tween, tween);
			gl.uniform1i(this.uniformLocations.preview, preview);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			this.twoD.drawImage(gl.canvas, 0, 0);
		}

	}

	const drawingContext = new DrawingContext(
		canvas, window.innerWidth, window.innerHeight, 1,
		document.getElementById('canvas-overlay')
	);
	const signatureBox = document.getElementById('author-hitbox');
	let signatureChanged = true;
	let signatureWidth, signatureHeight, userDisplayName;
	let signatureText = '';
	const signatureFont = 'italic 20px Pacifico, cursive';
	const signaturePaddingX = 3;
	const wmFont = '20px "Alfa Slab One", sans-serif';
	const wmText = 'https://mathematical-art.github.io';
	let wmWidth, wmHeight;

	function calcSignature() {
		signatureText = '';
		let sketchAuthor;
		if (currentSketch) {
			sketchAuthor = currentSketch.author;
		}
		if (sketchAuthor) {
			signatureText = sketchAuthor;
			if (userDisplayName) {
				signatureText += ' & ';
			}
		}
		if (userDisplayName) {
			signatureText += userDisplayName;
		}
		if (signatureText === '') {
			signatureWidth = 100;
			signatureHeight = 30;
		} else {
			const context = drawingContext.twoD;
			context.font = signatureFont;
			context.textAlign = 'left';
			context.textBaseline = 'bottom';
			const metrics = context.measureText(signatureText);
			signatureWidth = 2 * signaturePaddingX + Math.ceil(metrics.actualBoundingBoxRight);
			signatureHeight = 4 + 1 + Math.ceil(metrics.actualBoundingBoxAscent);
		}
		signatureBox.style.width = signatureWidth + 'px';
		signatureBox.style.height = signatureHeight + 'px';
		signatureChanged = false;
	}

	function drawSignature(contextualInfo, sample) {
		const context = contextualInfo.twoD;
		contextualInfo.save2DMatrix();
		if (signatureChanged) {
			calcSignature();
		} else {
			context.textAlign = 'left';
			context.textBaseline = 'bottom';
		}
		if (signatureText === '') {
			return;
		}

		const canvas = context.canvas;
		let canvasWidth = canvas.width;
		let canvasHeight = canvas.height;
		const backgroundColor = backgroundElement.style.backgroundColor;
		let [bgRed, bgGreen, bgBlue] = parseColor(backgroundColor)[1];
		let boxBgRed = bgRed, boxBgGreen = bgGreen, boxBgBlue = bgBlue;
		let featherOpacity = 1;
		if (sample) {
			featherOpacity = 0.2;
			const pixels = context.getImageData(0, canvasHeight - signatureHeight, signatureWidth, signatureHeight).data;
			let totalRed = 0, totalGreen = 0, totalBlue = 0;
			const numSamples = 50;
			for (let i = 0; i < numSamples; i++) {
				const x = Math.trunc(Math.random() * signatureWidth);
				const y = Math.trunc(Math.random() * signatureHeight);
				const offset = (y * signatureWidth + x) * 4;
				const alpha = pixels[offset + 3] / 255;
				const bgAmount = 1 - alpha;
				totalRed += alpha * pixels[offset] + bgAmount * bgRed;
				totalGreen += alpha * pixels[offset + 1] + bgAmount * bgGreen;
				totalBlue += alpha * pixels[offset + 2] + bgAmount * bgBlue;
			}
			boxBgRed = totalRed / numSamples;
			boxBgGreen = totalGreen / numSamples;
			boxBgBlue = totalBlue / numSamples;
		}

		const scale = contextualInfo.scale;
		const scaledWidth = canvasWidth / scale;
		const scaledHeight = canvasHeight / scale;
		const fontSize = Math.ceil(20 / scale);
		context.font = signatureFont.replace('20', fontSize);
		const sSignatureWidth = signatureWidth / scale;
		const sSignatureHeight = signatureHeight / scale;
		const top = scaledHeight - sSignatureHeight;
		const paddingX = Math.round(signaturePaddingX / scale);
		const paddingY = Math.round(4 / scale);
		const onePx = 1 / scale;
		const gradient = context.createLinearGradient(0, top, 0, top + paddingY);
		gradient.addColorStop(0, rgba(boxBgRed, boxBgGreen, boxBgBlue, featherOpacity));
		gradient.addColorStop(1, rgba(boxBgRed, boxBgGreen, boxBgBlue, 1));
		context.fillStyle = gradient;
		context.fillRect(0, top, sSignatureWidth, sSignatureHeight);
		let luma = rgbToLuma(boxBgRed, boxBgGreen, boxBgBlue);
		context.fillStyle = luma >= 0.5 ? 'black' : '#eee';
		const bottom = scaledHeight - onePx;
		context.fillText(signatureText, paddingX, bottom);

		if (sample) {
			const pixels = context.getImageData(canvasWidth - wmWidth, canvasHeight - wmHeight, wmWidth, wmHeight).data;
			let totalRed = 0, totalGreen = 0, totalBlue = 0;
			const numSamples = 50;
			for (let i = 0; i < numSamples; i++) {
				const x = Math.trunc(Math.random() * wmWidth);
				const y = Math.trunc(Math.random() * wmHeight);
				const offset = (y * signatureWidth + x) * 4;
				const alpha = pixels[offset + 3] / 255;
				const bgAmount = 1 - alpha;
				totalRed += alpha * pixels[offset] + bgAmount * bgRed;
				totalGreen += alpha * pixels[offset + 1] + bgAmount * bgGreen;
				totalBlue += alpha * pixels[offset + 2] + bgAmount * bgBlue;
			}
			boxBgRed = totalRed / numSamples;
			boxBgGreen = totalGreen / numSamples;
			boxBgBlue = totalBlue / numSamples;
			luma = rgbToLuma(boxBgRed, boxBgGreen, boxBgBlue);
		}

		context.font = wmFont.replace('20', fontSize);
		context.textAlign = 'right';
		context.lineWidth = 2;
		if (luma > 0.5) {
			context.fillStyle = '#000000b0';
			context.strokeStyle = '#ffffffb0';
		} else {
			context.globalAlpha = 0.5 + 0.5 * luma;
			context.fillStyle = 'white';
			context.strokeStyle = 'black';
		}
		context.fillText(wmText, scaledWidth - paddingX, bottom);
		context.strokeText(wmText, scaledWidth - paddingX, bottom);
	}

	function drawSignatureWhenReady(contextualInfo, sample) {
		Promise.allSettled([
			document.fonts.load(signatureFont),
			document.fonts.load(wmFont).then(function () {
				const context = drawingContext.twoD;
				context.font = wmFont;
				context.textAlign = 'right';
				context.textBaseline = 'bottom';
				const metrics = context.measureText(wmText);
				wmWidth = Math.ceil(metrics.actualBoundingBoxLeft);
				wmHeight = 1 + Math.ceil(metrics.actualBoundingBoxAscent);
			}),
		]).then(function () {
			drawSignature(contextualInfo, sample);
		});
	}

	function progressiveBackgroundDraw(generator, contextualInfo, width, height, preview, callback) {
		const context = contextualInfo.twoD;
		if (generator.isShader) {
			contextualInfo.drawGL(parseFloat(animPositionSlider.value), preview);
			restoreCanvas(context);
			callback(contextualInfo);
			document.body.classList.remove('cursor-progress');
		} else {
			random.reset();
			const redraw = generator.generate(context, width, height, preview);
			backgroundRedraw = redraw;
			let done = false;
			let totalUnits = 0;
			let totalTime = 1;
			function drawSection() {
				if (backgroundRedraw === redraw) {
					unitsProcessed = 0;
					const startTime = performance.now();
					yieldTime = startTime + redrawInterval;
					done = redraw.next().done;
					totalTime += performance.now() - startTime;
					totalUnits += unitsProcessed;
					if (done) {
						restoreCanvas(context);
						callback(contextualInfo);
						if (totalUnits > 0) {
							benchmark = Math.trunc(totalUnits / totalTime * redrawInterval);
						}
						backgroundRedraw = undefined;
						document.body.classList.remove('cursor-progress');
					} else {
						requestAnimationFrame(drawSection);
					}
				}
			}
			requestAnimationFrame(drawSection);
		}
	}

	function calcSize(width, height, scale, scaleMode) {
		let scaledWidth, scaledHeight;
		if (scale === 0) {
			scaledWidth = 1;
			scaledHeight = 1;
		} else {
			if (scaleMode === ScaleMode.VIEWPORT) {
				scaledWidth = width;
				scaledHeight = height;
			} else {
				let length;
				if (scaleMode === ScaleMode.CONTAIN) {
					length = Math.min(width, height) / Math.SQRT2;
				} else {
					/* This alternative equation looks good: length = (width + height) / Math.SQRT2
					 * Length to completely fill the screen = Math.hypot(width, height)
					 */
					length = Math.hypot(width, height);
				}
				scaledWidth = length;
				scaledHeight = length;
			}
			scaledWidth = Math.ceil(scaledWidth * scale);
			scaledHeight = Math.ceil(scaledHeight * scale);
		}
		return [scaledWidth, scaledHeight];
	}

	function calcBlur(value) {
		if (value < 0.5) {
			// Compress values between 0.4 and 0.5 into 0 to 0.5 pixels of blur
			value = (value - 0.4) * 5;
		}
		if (value === 0) {
			return '';
		} else {
			return 'blur(' + value + 'px)';
		}
	}


	function transformCanvas(context, width, height, renderWidth, renderHeight, rotation) {
		context.translate(Math.trunc(width / 2), Math.trunc(height / 2));
		context.rotate(rotation);
		context.translate(Math.trunc(-renderWidth / 2), Math.trunc(-renderHeight / 2));
	}

	function restoreCanvas(context) {
		context.restore();
		context.save();
	}

	function drawBackgroundImage(contextualInfo) {
		if (backgroundImage !== undefined) {
			const context = contextualInfo.twoD;
			const canvas = context.canvas;
			context.globalCompositeOperation = 'destination-over';
			context.drawImage(backgroundImage, 0, 0, canvas.width, canvas.height);
			context.globalCompositeOperation = 'source-over';
		}
	}

	function postDraw(contextualInfo) {
		drawBackgroundImage(drawingContext);
		drawSignatureWhenReady(contextualInfo, true);
	}

	function progressiveBackgroundGen(preview = 0, afterProc = undefined) {
		document.body.classList.add('cursor-progress');
		const context = drawingContext.twoD;
		restoreCanvas(context);
		const width = canvas.width;
		const height = canvas.height;
		const [scaledWidth, scaledHeight] = calcSize(width, height, scale, scaleMode);
		context.clearRect(0, 0, width, height);
		transformCanvas(context, width, height, scaledWidth, scaledHeight, rotation);
		context.globalAlpha = opacity;
		afterProc = afterProc || postDraw;
		progressiveBackgroundDraw(bgGenerator, drawingContext, scaledWidth, scaledHeight, preview, afterProc);
	}

	generateBackground = progressiveBackgroundGen;
	setBgProperty = drawingContext.setProperty.bind(drawingContext);
	setBgPropertyElement = drawingContext.setPropertyElement.bind(drawingContext);

	function redraw() {
		progressiveBackgroundGen(0)
	}

	bgGeneratorImage.onload = redraw;

	let currentSketch, generatorURL, startFrame, endFrame, tweenData, animController;
	let helpDoc, helpContextItem;
	let helpContext = false;
	let helpContextIntermediate = false; // True after mouse down but before mouse click.

	globalThis.inHelpContext = function () {
		return helpContext;
	};

	/* The current frame according to the interpolation, not necessarily what's displayed
	 * on screen because there can be unsaved changes. */
	let currentFrame;
	// The action requested when unsaved changes were detected.
	let animAction;
	let fullRotations = 0, loopAnim = false;

	const errorAlert = $('#error-alert');
	const successAlert = $('#success-alert');
	const videoErrorAlert = $('#video-error');
	videoErrorAlert.on('closed.bs.alert', function (event) {
		this.hidden = true;
	});

	const authorForm = document.getElementById('author-form');
	const authorInput = document.getElementById('author');

	const sketchCards = document.getElementById('sketch-list');
	const modal = document.getElementById('background-gen-modal');
	const modalHeader = document.getElementById('background-gen-modal-header');
	const rotationSlider = document.getElementById('layer-rotation');
	const opacitySlider = document.getElementById('layer-opacity');
	const scaleSlider = document.getElementById('layer-scale');
	const blurSlider = document.getElementById('layer-blur');
	const toolbar = document.getElementById('toolbar');
	const seedForm = document.getElementById('random-seed-form');
	const seedInput = document.getElementById('random-seed');
	const progressBar = document.getElementById('video-progress');
	const imageUpload = document.getElementById('background-gen-image');
	imageUpload.remove();
	imageUpload.removeAttribute('hidden');

	const animPositionSlider = document.getElementById('anim-position');
	let animControlsOpen = false;
	const videoResolutionInput = document.getElementById('video-resolution');

	class FrameData {
		constructor(generator, rotation, backgroundElement, backgroundImage) {
			this.continuous = new Map();
			this.stepped = new Map();
			this.pairedContinuous = new Map();
			this.pairedStepped = new Map();
			this.xy = new Map();
			this.nominalArrays = new Map();
			if (arguments.length === 0) {
				// Used by the frameDataFromObject function
				this.backgroundColor = '#ffffff';
				this.backgroundImage = undefined;
				this.opacity = 1;
				this.rotation = 0;
				this.scale = 1;
				this.scaleMode = ScaleMode.VIEWPORT;
				this.blur = 0.4;
				this.random = random;
				return;
			}

			const animatable = generator.animatable
			if (animatable !== undefined) {
				const continuous = animatable.continuous;
				if (continuous !== undefined) {
					for (let property of continuous) {
						const value = deepArrayCopy(generator[property]);
						this.continuous.set(property, value);
					}
				}
				const stepped = animatable.stepped;
				if (stepped !== undefined) {
					for (let property of stepped) {
						const value = deepArrayCopy(generator[property]);
						this.stepped.set(property, value);
					}
				}
				const pairedContinuous = animatable.pairedContinuous;
				if (pairedContinuous !== undefined) {
					for (let [property1, property2] of pairedContinuous) {
						const value1 = deepArrayCopy(generator[property1]);
						const value2 = deepArrayCopy(generator[property2]);
						this.pairedContinuous.set(property1, value1);
						this.pairedContinuous.set(property2, value2);
					}
				}
				const pairedStepped = animatable.pairedStepped;
				if (pairedStepped !== undefined) {
					for (let [property1, property2] of pairedStepped) {
						const value1 = deepArrayCopy(generator[property1]);
						const value2 = deepArrayCopy(generator[property2]);
						this.pairedStepped.set(property1, value1);
						this.pairedStepped.set(property2, value2);
					}
				}
				const xy = animatable.xy;
				if (xy !== undefined) {
					for (let [property1, property2] of xy) {
						const value1 = generator[property1];
						const value2 = generator[property2];
						this.xy.set(property1, value1);
						this.xy.set(property2, value2);
					}
				}
				const nominalArray = animatable.nominalArray;
				if (nominalArray !== undefined) {
					for (let property of nominalArray) {
						const value = deepArrayCopy(generator[property]);
						this.nominalArrays.set(property, value);
					}
				}
			}
			this.backgroundColor = backgroundElement.style.backgroundColor;
			this.backgroundImage = backgroundImage;
			this.opacity = opacity;
			this.rotation = rotation;
			this.scale = scale;
			this.scaleMode = scaleMode;
			this.blur = blur;
			this.random = random;
		}

		toObject() {
			const properties = {};
			const categories = [
				'continuous', 'stepped', 'pairedContinuous', 'xy', 'pairedStepped'
			];
			for (let category of categories) {
				const map = this[category];
				for (let key of map.keys()) {
					properties[key] = map.get(key);
				}
			}
			const data = {};
			data.properties = properties;
			data.backgroundColor = this.backgroundColor;
			if (this.backgroundImage !== undefined) {
				data.backgroundImageURL = this.backgroundImage.src;
			}
			data.opacity = this.opacity;
			data.rotation = this.rotation;
			data.scale = this.scale;
			data.scaleMode = this.scaleMode;
			data.blur = this.blur;
			data.seed = this.random.seed;
			return data;
		}

		isCurrentFrame() {
			if (
				this.backgroundColor !== backgroundElement.style.backgroundColor ||
				this.backgroundImage?.src !== backgroundImage?.src ||
				this.rotation !== rotation ||
				this.opacity !== opacity ||
				this.scale !== scale ||
				this.scaleMode !== scaleMode ||
				this.blur !== blur
			) {
				return false;
			}
			const currentSeed = random.seed;
			if (
				this.random.seed !== currentSeed &&
				this.random.startGenerator.seed !== currentSeed &&
				this.random.endGenerator.seed !== currentSeed
			) {
				return false;
			}


			const animatable = bgGenerator.animatable;
			if (animatable === undefined) {
				return this.continuous.size === 0 && this.stepped.size === 0 &&
					this.pairedContinuous.size === 0 && this.pairedStepped.size === 0;
			}

			const continuous = animatable.continuous;
			if (continuous === undefined) {
				if (this.continuous.size > 0) {
					return false;
				}
			} else {
				if (this.continuous.size !== continuous.length) {
					return false;
				}
				for (let i = 0; i < continuous.length; i++) {
					const key = continuous[i];
					const frameValue = this.continuous.get(key);
					const currentValue = bgGenerator[key];
					if (!deepEquals(frameValue, currentValue)) {
						return false;
					}
				}
			}

			const stepped = animatable.stepped;
			if (stepped === undefined) {
				if (this.stepped.size > 0) {
					return false;
				}
			} else {
				if (this.stepped.size !== stepped.length) {
					return false;
				}
				for (let i = 0; i < stepped.length; i++) {
					const key = stepped[i];
					const frameValue = this.stepped.get(key);
					const currentValue = bgGenerator[key];
					if (!deepEquals(frameValue, currentValue)) {
						return false;
					}
				}
			}

			const pairedContinuous = animatable.pairedContinuous;
			if (pairedContinuous === undefined) {
				if (this.pairedContinuous.size > 0) {
					return false;
				}
			} else {
				if (this.pairedContinuous.size !== pairedContinuous.length * 2) {
					return false;
				}
				for (let i = 0; i < pairedContinuous.length; i++) {
					const keys = pairedContinuous[i];
					const key1 = keys[0];
					const frameValue1 = this.pairedContinuous.get(key1);
					const currentValue1 = bgGenerator[key1];
					if (!deepEquals(frameValue1, currentValue1)) {
						return false;
					}
					const key2 = keys[1];
					const frameValue2 = this.pairedContinuous.get(key2);
					const currentValue2 = bgGenerator[key2];
					if (!deepEquals(frameValue2, currentValue2)) {
						return false;
					}
				}
			}

			const xy = animatable.xy;
			if (xy === undefined) {
				if (this.xy.size > 0) {
					return false;
				}
			} else {
				if (this.xy.size !== xy.length * 2) {
					return false;
				}
				for (let i = 0; i < xy.length; i++) {
					const keys = xy[i];
					const key1 = keys[0];
					const frameValue1 = this.xy.get(key1);
					const currentValue1 = bgGenerator[key1];
					if (frameValue1 !== currentValue1) {
						return false;
					}
					const key2 = keys[1];
					const frameValue2 = this.xy.get(key2);
					const currentValue2 = bgGenerator[key2];
					if (frameValue2 !== currentValue2) {
						return false;
					}
				}
			}

			const pairedStepped = animatable.pairedStepped;
			if (pairedStepped === undefined) {
				if (this.pairedStepped.size > 0) {
					return false;
				}
			} else {
				if (this.pairedStepped.size !== pairedStepped.length * 2) {
					return false;
				}
				for (let i = 0; i < pairedStepped.length; i++) {
					const keys = pairedStepped[i];
					const key1 = keys[0];
					const frameValue1 = this.pairedStepped.get(key1);
					const currentValue1 = bgGenerator[key1];
					if (!deepEquals(frameValue1, currentValue1)) {
						return false;
					}
					const key2 = keys[1];
					const frameValue2 = this.pairedStepped.get(key2);
					const currentValue2 = bgGenerator[key2];
					if (!deepEquals(frameValue2, currentValue2)) {
						return false;
					}
				}
			}
			return true;
		}

	}

	function currentFrameData() {
		return new FrameData(bgGenerator, rotation, backgroundElement, backgroundImage);
	}

	function frameDataFromObject(data, generator) {
		const frame = new FrameData();
		const animatable = generator.animatable;
		if (animatable !== undefined) {
			const values = data.properties;
			const continuous = animatable.continuous;
			if (continuous !== undefined) {
				for (let property of continuous) {
					if (property in values) {
						frame.continuous.set(property, values[property]);
					}
				}
			}
			const stepped = animatable.stepped;
			if (stepped !== undefined) {
				for (let property of stepped) {
					if (property in values) {
						frame.stepped.set(property, values[property]);
					}
				}
			}
			const maps = ['pairedContinuous', 'xy', 'pairedStepped'];
			for (let mapName of maps) {
				const list = animatable[mapName];
				if (list !== undefined) {
					const map = frame[mapName];
					for (let [property1, property2] of list) {
						if (property1 in values) {
							map.set(property1, values[property1]);
						}
						if (property2 in values) {
							map.set(property2, values[property2]);
						}
					}
				}
			}
		}
		frame.backgroundColor = data.backgroundColor;
		if ('backgroundImageURL' in data) {
			const image = new Image();
			image.src = data.backgroundImageURL;
			frame.backgroundImage = image;
		}
		frame.rotation = data.rotation;
		frame.opacity = data.opacity;
		frame.scale = data.scale;
		frame.scaleMode = data.scaleMode;
		frame.blur = data.blur;
		if ('seed' in data) {
			frame.random = new RandomNumberGenerator(data.seed);
		}
		return frame;
	}

	function hideAlert(jquery) {
		jquery.alert('close');
	}

	function showAlert(jquery, message, parent) {
		const elem = jquery.get(0);
		elem.children[0].innerHTML = message;
		elem.classList.add('show');
		parent.appendChild(elem);
		clearTimeout(elem.timeout);
		elem.timeout = setTimeout(hideAlert, 8000, jquery);
	}

	const modalMargin = 0;
	modal.style.left = Math.max(Math.round(window.innerWidth - 506 - modalMargin), 0) + 'px';

	function repositionModal(centre) {
		if (modal.classList.contains('show')) {
			const child = modal.children[0];
			const rect = child.getBoundingClientRect();
			const maxRight = window.innerWidth - modalMargin;
			const smallScreen = window.innerWidth < 1200;

			if (rect.right > maxRight || smallScreen) {
				modal.style.left = Math.max(Math.round(maxRight - rect.width), 0) + 'px';
			}
			if (smallScreen) {
				modal.style.top = '0px';
				return;
			}

			const maxBottom = window.innerHeight - toolbar.clientHeight;

			if (centre) {
				const grandchild = modal.children[0].children[0];
				let top = Math.max(Math.round((maxBottom - grandchild.clientHeight) / 2), 0);
				modal.style.top = top + 'px';
			} else {
				const childHeight = child.clientHeight;
				if (rect.top +  childHeight > maxBottom) {
					modal.style.top = Math.max(Math.round(maxBottom - childHeight), 0) + 'px';
				}
			}
		}
	}

	function resetControl(event) {
		const id = this.dataset.reset;
		const control = document.getElementById(id);
		let value = control.getAttribute('value');
		control.value = value;
		const controlType = control.type;
		if (controlType === 'range' || controlType === 'number') {
			value = parseFloat(value);
		}
		let match = id.match(/-(\d+)$/);
		let property = idToProperty(id, true);
		if (!(property in bgGenerator) && match !== null) {
			property = property.slice(0, -match[1].length);
			const index = parseInt(match[1]);
			if (bgGenerator.isShader) {
				drawingContext.setPropertyElement(bgGenerator, property, index, value);
			} else {
				bgGenerator[property][index] = value;
			}
		} else {
			if (bgGenerator.isShader) {
				drawingContext.setProperty(bgGenerator, property, value);
			} else {
				bgGenerator[property] = value;
			}
		}
		progressiveBackgroundGen(0);
	}

	function openSketch() {
		document.getElementById('btn-open-sketch').click();
	}

	function enableOpenButton() {
		document.getElementById('btn-open-sketch').disabled = false;
	}

	const inputsToSketches = new Map();

	function addSketch(sketch) {
		const label = document.createElement('LABEL');
		label.classList.add('btn' , 'p-1', 'm-1');
		const input = document.createElement('INPUT');
		input.type = 'radio';
		input.name = 'sketch';
		inputsToSketches.set(input, sketch);
		label.appendChild(input);
		const card = document.createElement('DIV');
		card.classList.add('card', 'm-0', 'h-100');
		label.appendChild(card);
		let thumbnail;
		if (sketch.thumbnail) {
			thumbnail = document.createElement('IMG');
			thumbnail.loading = 'lazy';
			thumbnail.src = 'sketch/thumbnail/' + sketch.thumbnail;
			thumbnail.alt = sketch.title;
			thumbnail.width = 168;
			thumbnail.height = 168;
		} else {
			thumbnail = document.createElement('DIV');
			thumbnail.classList.add('bg-dark', 'text-white', 'no-thumbnail');
			const thumbContent = document.createElement('DIV');
			thumbContent.classList.add('vertical-center', 'w-100', 'text-center');
			thumbnail.appendChild(thumbContent);
			thumbContent.innerHTML = 'No Preview Available';
		}
		thumbnail.classList.add('card-img-top');
		card.appendChild(thumbnail);
		const body = document.createElement('DIV');
		body.classList.add('card-body')
		card.appendChild(body);
		const title = document.createElement('H6');
		title.innerHTML = sketch.title;
		title.classList.add('card-title', 'text-center', 'text-dark');
		body.appendChild(title);
		sketchCards.appendChild(label);
		label.addEventListener('click', enableOpenButton);
		label.addEventListener('dblclick', openSketch);
	}

	function updateURL() {
		let envURL = document.location;
		envURL = envURL.origin + envURL.pathname + '?' + urlParameters.toString();
		history.replaceState(null, '', envURL.toString());
	}

	function findBrokenHTML() {
		// Find mislabelled help entries
		if (helpDoc) {
			for (let helpElement of helpDoc.body.children) {
				const id = helpElement.id;
				const element = document.getElementById(id);
				if (element === null) {
					console.warn('Help exists for ' + id + ' but no such element is present.');
				}
			}
		}

		// Find mismatched labels
		for (let label of document.getElementsByTagName('label')) {
			const id = label.htmlFor;
			if (id && document.getElementById(id) === null) {
				console.warn('<label for="' + id + '"> found but no control with that id is present.');
			}
		}
	}

	function findMissingHelp() {
		const container = document.getElementById('background-gen-options');
		const ancestorIDs = new Map();
		for (let element of container.querySelectorAll('input, button')) {
			let id = element.id;
			if (id === 'background-gen-image-upload' || ('reset' in element.dataset)) {
					continue;
			}
			const tagName = element.tagName.toLowerCase();
			const type = tagName === 'input' ? element.type : tagName;
			let ancestor = element;
			while (id === '' && ancestor !== container) {
				ancestor = ancestor.parentElement;
				id = ancestor.id;
			}
			let foundHelp = false;
			if (helpDoc !== undefined) {
				let helpAncestor = ancestor;
				let helpID = id;
				while (
					((foundHelp = helpDoc.getElementById(helpID) !== null) === false) &&
					helpAncestor !== container
				) {
					helpAncestor = helpAncestor.parentElement;
					helpID = helpAncestor.id;
				}
			}
			if (!foundHelp) {
				if (ancestor === element) {
					console.log(id);
				} else {
					if (id === '') {
						id = 'the container';
					}
					let counts = ancestorIDs.get(id);
					if (counts === undefined) {
						counts = new Map();
						ancestorIDs.set(id, counts);
					}
					let count = counts.get(type);
					if (count === undefined) {
						count = 0;
					}
					count++;
					counts.set(type, count);
				}
			}
		}
		for (let [parentID, counts] of ancestorIDs.entries()) {
			for (let [type, count] of counts.entries()) {
				console.log(count + ' children of ' + parentID + ' with type ' + type);
			}
		}
	}
	globalThis.findMissingHelp = findMissingHelp;

	function canvasClick(event) {
		if (event.button !== 0) {
			return;
		}
		const x = event.clientX;
		const y = event.clientY;
		const [transformedX, transformedY] = drawingContext.transform2DPoint(x, y);
		const context = drawingContext.twoD;
		const width = canvas.width;
		const height = canvas.height;
		const [scaledWidth, scaledHeight] = calcSize(width, height, scale, scaleMode);
		bgGenerator.onclick(transformedX, transformedY, scaledWidth, scaledHeight);
	}

	let dragStartX, dragStartY;

	function canvasDrag(event) {
		const shape = drawingContext.svg.children[0];
		let x = Math.round(event.clientX);
		let y = Math.round(event.clientY);
		let width = x - dragStartX;
		let height = y - dragStartY;

		switch (shape.tagName) {
		case 'circle':
			const radius = Math.hypot(width, height);
			shape.setAttribute('r', radius);
			break;

		case 'line':
			shape.setAttribute('x2', x);
			shape.setAttribute('y2', y);
			break;

		case 'rect':
			if (width < 0) {
				shape.setAttribute('x', x);
				width = -width;
			}
			if (height < 0) {
				shape.setAttribute('y', y);
				height = -height;
			}
			shape.setAttribute('width', width);
			shape.setAttribute('height', height);
			break;
		}
	}

	function canvasDragEnd() {
		const svg = drawingContext.svg;
		svg.removeEventListener('pointermove', canvasDrag);
		svg.removeEventListener('pointerup', canvasMouseUp);
		svg.removeEventListener('pointerleave', canvasDragEnd);
		svg.children[0].setAttribute('visibility', 'hidden');
	}

	function canvasMouseUp(event) {
		canvasDragEnd();
		const shape = drawingContext.svg.children[0];
		const shapeType = shape.tagName;
		let x1, y1, x2, y2, radius, width, height;
		switch (shapeType) {
		case 'circle':
			x1 = dragStartX;
			y1 = dragStartY;
			radius = shape.r.baseVal.value;
			width = radius;
			height = radius;
			break;

		case 'line':
			x1 = dragStartX;
			y1 = dragStartY;
			x2 = shape.x2.baseVal.value;
			y2 = shape.y2.baseVal.value;
			width = Math.abs(x2 - x1);
			height = Math.abs(y2 - y1);
			break;

		case 'rect':
			x1 = shape.x.baseVal.value;
			y1 = shape.y.baseVal.value;
			width = shape.width.baseVal.value;
			height = shape.height.baseVal.value;
			x2 = x1 + width;
			y2 = y1 + height;
			break;
		}
		if (width < 4 && height < 4) {
			return;
		}
		let [transformedX1, transformedY1] = drawingContext.transform2DPoint(x1, y1);
		let transformedX2, transformedY2;
		if (shapeType === 'circle') {
			[transformedX2, transformedY2] = [transformedX1 + radius, transformedY1];
		} else {
			[transformedX2, transformedY2] = drawingContext.transform2DPoint(x2, y2);
		}
		const context = drawingContext.twoD;
		const canvasWidth = canvas.width;
		const canvasHeight = canvas.height;
		const [scaledWidth, scaledHeight] = calcSize(canvasWidth, canvasHeight, scale, scaleMode);
		if (bgGenerator.isShader) {
			transformedY1 = scaledHeight - transformedY1;
			transformedY2 = scaledHeight - transformedY2;
		}
		bgGenerator.ondrag(transformedX1, transformedY1, transformedX2, transformedY2, scaledWidth, scaledHeight);
	}

	function canvasMouseDown(event) {
		if (event.button !== 0) {
			canvasDragEnd();
			return;
		}
		dragStartX = Math.round(event.clientX);
		dragStartY = Math.round(event.clientY);
		const svg = drawingContext.svg;
		let shape = svg.children[0];
		const shapeType = bgGenerator.dragShape || 'rect';
		if (shape.tagName !== shapeType) {
			shape.remove();
			shape = document.createElementNS('http://www.w3.org/2000/svg', shapeType);
			switch (shapeType) {
			case 'line':
				svg.style.mixBlendMode = 'difference';
				shape.setAttribute('stroke', 'white');
				shape.setAttribute('stroke-width', 3);
				break;

			case 'circle':
			case 'rect':
				svg.style.mixBlendMode = 'normal';
				shape.setAttribute('fill', 'hsla(210, 50%, 50%, 0.55)');
				break;
			}
			svg.appendChild(shape);
		}
		switch (shapeType) {
		case 'circle':
			shape.setAttribute('cx', dragStartX);
			shape.setAttribute('cy', dragStartY);
			shape.setAttribute('r', 0);
			break;

		case 'line':
			shape.setAttribute('x1', dragStartX);
			shape.setAttribute('x2', dragStartX);
			shape.setAttribute('y1', dragStartY);
			shape.setAttribute('y2', dragStartY);
			break;

		case 'rect':
			shape.setAttribute('x', dragStartX);
			shape.setAttribute('y', dragStartY);
			shape.setAttribute('width', 0);
			shape.setAttribute('height', 0)
			break;
		}
		shape.setAttribute('visibility', 'visible');
		svg.addEventListener('pointermove', canvasDrag);
		svg.addEventListener('pointerup', canvasMouseUp);
		svg.addEventListener('pointerleave', canvasDragEnd);
	}

	drawingContext.svg.addEventListener('pointerdown', canvasMouseDown);

	function displaySeed() {
		if (startFrame.random.seed === endFrame.random.seed) {
			seedInput.value = startFrame.random.seed;
		} else {
			seedInput.value = startFrame.random.seed + '\n' + endFrame.random.seed;
		}
	}

	function restoreWebGL() {
		if (bgGenerator.isShader) {
			drawingContext.restoreShader(bgGenerator);
			progressiveBackgroundGen(0);
		}
	}

	async function switchGenerator(url, pushToHistory) {
		// Hide stuff while it changes
		const container = document.getElementById('background-gen-options');
		const titleBar = document.getElementById('background-gen-modal-label');
		const randomControls = document.getElementById('generate-btn-group');
		const hadRandomness = !randomControls.hidden;
		container.hidden = true;
		titleBar.innerHTML = 'Loading&hellip;';

		// Switch generator
		let gen, optionsDoc;
		try {
			const resolvedURL = /^(\w+:)?\//.test(url) ? url : filePath + url;
			const genModule = await import(resolvedURL)
			const constructor = genModule.default;
			randomControls.hidden = true;
			gen = new constructor();
			optionsDoc = await gen.optionsDocument;
			if (gen.isShader) {
				const fragFileContent = (await Promise.all([
					requireScript('lib/gl-matrix.min.js'),
					downloadFile(url.slice(0, -3) + '.frag', 'text')
				]))[1];
				gen.shaderSource =
					fragmentShaderHeader +
					shaderDeclarations(gen) +
					fragFileContent;
				drawingContext.initializeShader(gen);
				drawingContext.gl.canvas.addEventListener('webglcontextrestored', restoreWebGL);
				drawingContext.inferTypes(gen);
				drawingContext.setProperties(gen);
			}
		} catch (e) {
			if (bgGenerator === undefined) {
				$('#sketches-modal').modal('show');
			} else {
				// Keep previous generator
				container.hidden = false;
				titleBar.innerHTML = bgGenerator.title;
				randomControls.hidden = !hadRandomness;
			}
			showAlert(errorAlert, 'The requested sketch could not be loaded.<br>' + escapeHTML(e.message), document.body);
			console.error(e);
			return;
		}

		// Set the new generator as the current one.
		const svg = drawingContext.svg;
		svg.removeEventListener('pointerdown', canvasMouseDown);
		svg.removeEventListener('click', canvasClick);
		bgGenerator = gen;
		generatorURL = url;
		if (currentSketch && currentSketch.url !== url) {
			currentSketch = undefined;
		}
		benchmark = Infinity;

		// Reset layer geometry
		const backgroundColor = gen.backgroundColor;
		if (Array.isArray(backgroundColor)) {
			backgroundElement.style.backgroundColor = rgba(...backgroundColor, 1);
			document.getElementById('background-color').value = rgbToHex(...backgroundColor);
		}
		rotation = 0;
		rotationSlider.value = 0;
		scale = 1;
		scaleSlider.value = 1;
		scaleMode = ScaleMode.VIEWPORT;
		document.getElementById('rotation-size-screen').checked = true;
		blur = 0.4;
		blurSlider.value = 0.4;

		// Initialize sketch
		currentFrame = currentFrameData();
		startFrame = currentFrame;
		endFrame = startFrame;
		displaySeed();
		// Hide the save button for experimental sketches
		const enableSave = (new URL(url, document.location)).hostname === document.location.hostname;
		const saveBtn = document.getElementById('btn-save-form');
		saveBtn.hidden = !enableSave;
		// Render sketch
		const hasTween = 'tween' in gen;
		if (hasTween) {
			gen.tween = parseFloat(animPositionSlider.value);
		}
		signatureChanged = true;
		progressiveBackgroundGen(0);
		calcTweenData();

		// Create new options dialog
		container.innerHTML = '';
		if (optionsDoc !== undefined) {
			for (let resetButton of optionsDoc.querySelectorAll('button[data-reset]')) {
				resetButton.addEventListener('click', resetControl);
			}
			const baseElem = document.createElement('BASE');
			baseElem.href = filePath;
			optionsDoc.head.prepend(baseElem);
			for (let img of optionsDoc.getElementsByTagName('IMG')) {
				img.src = img.src;
			}
			container.append(...optionsDoc.head.getElementsByTagName('STYLE'));
			container.append(...optionsDoc.body.children);
			const imageCtrlLocation = container.querySelector('[data-attach=image]');
			if (imageCtrlLocation !== null) {
				imageCtrlLocation.appendChild(imageUpload);
			}
		}

		// Adapt the environment's UI accordingly
		if (typeof(gen.ondrag) === 'function') {
			svg.addEventListener('pointerdown', canvasMouseDown);
			svg.style.cursor = 'crosshair';
		} else {
			svg.style.cursor = 'auto';
		}
		if (typeof(gen.onclick) === 'function') {
			svg.addEventListener('click', canvasClick);
		}
		document.getElementById('btn-both-frames').hidden = !hasTween;
		document.getElementById('btn-both-frames2').hidden = !hasTween;
		toolbar.hidden = false;
		if (pushToHistory) {
			const name = url.slice(0, -3);	// trim .js
			urlParameters.set('gen', name);
			updateURL();
		}
		titleBar.innerHTML = gen.title;
		document.title = gen.title;
		const sketchesModal = document.getElementById('sketches-modal');
		for (let close of sketchesModal.querySelectorAll('button[data-dismiss=modal]')) {
			close.hidden = false;
		}
		$(sketchesModal).modal({backdrop: true, keyboard: true, show: false});

		// Load help file & display new sketch options
		const helpArea = document.getElementById('help-sketch');
		helpArea.innerHTML = '';
		helpDoc = undefined;
		container.hidden = false;
		repositionModal(true);
		if (gen.helpFile) {
			try {
				helpDoc = await downloadFile(gen.helpFile, 'document');
				const intro = helpDoc.getElementById('about');
				if (intro !== null) {
					helpArea.appendChild(intro);
				}
			} catch (e) {
				console.error(e);
			}
		}
		if (debug.htmlChecks) {
			findBrokenHTML();
		}
	}

	async function loadDocument(documentID) {
		const data = {};
		// TODO Add user authentication
		data.user = '1';
		data.documentID = documentID;
		const options = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		};
		try {
			const response = await fetch(backendRoot + 'load', options);
			const doc = await response.json();
			if (doc) {
				await switchGenerator(doc.sketch, false);
				startFrame = frameDataFromObject(doc.startFrame, bgGenerator);
				currentFrame = startFrame;
				random = startFrame.random;
				if ('endFrame' in doc) {
					endFrame = frameDataFromObject(doc.endFrame, bgGenerator);
				} else {
					endFrame = startFrame;
				}
				progressiveBackgroundGen(0);
				calcTweenData();
				displaySeed();
				animPositionSlider.value = 0;
				updateAnimPositionReadout(0);
				return doc.sketch;
			} else {
				return undefined;
			}
		} catch (e) {
			console.error(e);
			return undefined;
		}
	}

	let mobileLayout = false;

	function adaptLayout() {
		const overlay = document.getElementById('overlay');
		const overlayContent = overlay.children[0];
		if (window.innerWidth < 1024) {
			if (!mobileLayout) {
				// Switch to mobile layout
				const buttons = toolbar.children[1].children;
				overlayContent.appendChild(toolbar.children[0]);	// Donate button
				while (buttons.length > 0) {
					overlayContent.appendChild(buttons[0]);
				}
				document.getElementById('btn-floating-action').hidden = false;
				mobileLayout = true;
			}
		} else {
			if (mobileLayout) {
				// Switch to desktop layout
				overlay.classList.remove('show');
				const buttons = overlayContent.children;
				toolbar.prepend(buttons[0]);	// Donate button
				const buttonBox = toolbar.children[1];
				while (buttons.length > 0) {
					buttonBox.appendChild(buttons[0]);
				}
				document.getElementById('btn-floating-action').hidden = true;
				mobileLayout = false;
			}
		}
	}
	adaptLayout();

	document.getElementById('overlay').addEventListener('click', function (event) {
		if (event.target === this) {
			this.classList.remove('show');
		}
	});

	document.getElementById('btn-floating-action').addEventListener('click', function (event) {
		document.getElementById('overlay').classList.add('show');
	});

	// After resizing, generate a new background to fit the new window size.
	let resizeTimer;
	function resizeWindow() {
		repositionModal(false);
		adaptLayout();
		drawingContext.resize(window.innerWidth, window.innerHeight);
		if (bgGenerator !== undefined) {
			tweenData.calcSize(startFrame, endFrame, canvas.width, canvas.height);
			progressiveBackgroundGen(0);
		}
	}

	window.addEventListener('resize', function (event) {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(resizeWindow, 100);
	});

	let modalDrag;
	let foregroundModal = modal;
	let titleBarHeight;

	function dragWindow(event) {
		if (event.buttons !== 1) {
			window.removeEventListener('pointermove', dragWindow);
			return;
		}

		const child = foregroundModal.children[0];
		let left = Math.round(event.clientX - modalDrag[0]);
		const maxLeft = window.innerWidth - 32;
		left = Math.min(left, maxLeft);

		let top = Math.max(Math.round(event.clientY - modalDrag[1]), 0);
		const maxTop = window.innerHeight - toolbar.clientHeight - titleBarHeight;
		top = Math.min(top, maxTop);
		foregroundModal.style.left = left + 'px';
		foregroundModal.style.top = top + 'px';
	}

	function windowToFront(target) {
		foregroundModal.classList.remove('modal-floating-foreground');
		target.classList.add('modal-floating-foreground');
		foregroundModal = target;
	}

	function clickInWindow(event) {
		windowToFront(this.closest('.modal'));
	}

	function startWindowDrag(event) {
		const target = event.target;
		if (target === this || target.tagName === 'H6') {
			windowToFront(this.closest('.modal'));
			window.addEventListener('pointermove', dragWindow);
			modalDrag = [event.offsetX, event.offsetY];
			titleBarHeight = this.clientHeight;
		}
	}

	function stopWindowDrag(event) {
		window.removeEventListener('pointermove', dragWindow);
	}

	function collapseWindow(event) {
		$(this.parentElement.parentElement.querySelector('.modal-body')).collapse('toggle');
	}

	function expandWindow(event) {
		windowToFront(this);
		$(this.querySelector('.modal-body')).collapse('show');
	}

	for (let floating of document.querySelectorAll('.modal-floating')) {
		const header = floating.querySelector('.modal-header');
		header.addEventListener('pointerdown', startWindowDrag);
		header.addEventListener('pointerup', stopWindowDrag);
		header.querySelector('.collapse-gadget').addEventListener('click', collapseWindow);
		const body = floating.querySelector('.modal-body');
		body.addEventListener('click', clickInWindow);
		const floatingJQ = $(floating);
		floatingJQ.on('show.bs.modal', expandWindow);
		floatingJQ.modal({focus: false, show: false});
	}

	$(modal).on('shown.bs.modal', function (event) {
		repositionModal(false);
	});

	{
		function layersModalShown(event) {
			for (let img of document.getElementById('rotation-sizing-row').getElementsByTagName('IMG')) {
				img.loading = 'eager';
			}
			$('#layers-modal').off('show.bs.modal', layersModalShown);
		}

		$('#layers-modal').on('show.bs.modal', layersModalShown);
	}

	// Initialization function.
	(async function () {
		const sketchesModal = document.getElementById('sketches-modal');
		let firstDocID = urlParameters.get('doc');
		let firstGenURL = urlParameters.get('gen');
		let nextStep;

		function showParameters() {
			$(modal).modal('show');
		}

		if (firstGenURL !== null) {
			firstGenURL += '.js';
			nextStep = showParameters;
		}
		if (firstDocID !== null) {
			const sketchURL = await loadDocument(firstDocID);
			if (sketchURL !== undefined) {
				firstGenURL = sketchURL;
				nextStep = showParameters;
			} else {
				firstDocID = null;
			}
		}
		if (firstGenURL === null) {
			nextStep = function () {
				$(sketchesModal).modal({backdrop: 'static', keyboard: false});
			};
		}

		const licensed = store !== undefined && store.getItem('licence-accepted') === 'true'
		document.getElementById('accept-licence').checked = licensed;

		if (store === undefined || store.getItem('no-welcome') !== 'true' || !licensed) {
			const helpModal = $('#help-modal');
			function initialDialogue(event) {
				const licensed = document.getElementById('accept-licence').checked;
				document.getElementById('licence-message').hidden = licensed;
				if (store !== undefined) {
					store.setItem('licence-accepted', licensed);
				}
				if (!licensed) {
					document.getElementById('licence').scrollIntoView();
					return false;
				} else if (nextStep) {
					nextStep();
					nextStep = undefined;
				}
			}
			helpModal.on('hide.bs.modal', initialDialogue);
			helpModal.modal('show');
		} else {
			document.getElementById('show-welcome').checked = false;
			nextStep();
		}

		const sketchFile = await downloadFile(rootPath + 'sketches.json', 'json');
		for (let sketch of sketchFile.sketches) {
			addSketch(sketch);
			if (sketch.url === firstGenURL) {
				currentSketch = sketch;
			}
		}

		if (!firstDocID && firstGenURL) {
			switchGenerator(firstGenURL, false);
		}
	})();

	function calcTween(tween, loop) {
		if (loop) {
			if (tween > 0.5) {
				return 1 - (tween - 0.5) * 2;
			} else {
				return tween * 2;
			}
		} else {
			return tween;
		}
	}

	function interpolateValue(startValue, endValue, tween, loop) {
		if (startValue === endValue) {
			return startValue;
		} else if (Array.isArray(startValue)) {
			const numStartComponents = startValue.length;
			const numEndComponents = endValue.length;
			const numComponents = Math.min(numStartComponents, numEndComponents);
			const output = new Array(numComponents);
			for (let i = 0; i < numComponents; i++) {
				output[i] = interpolateValue(startValue[i], endValue[i], tween, loop);
			}
			const maxIndex = interpolateStep(numStartComponents, numEndComponents, tween, loop);
			if (numStartComponents > numEndComponents) {
				for (let i = numEndComponents; i < maxIndex; i++) {
					output[i] = startValue[i];
				}
			} else if (numEndComponents > numStartComponents) {
				for (let i = numStartComponents; i < maxIndex ; i++) {
					output[i] = endValue[i];
				}
			}
			return output;
		}

		tween = calcTween(tween, loop);
		const type = typeof(startValue);
		if (type === 'number') {
			return (endValue - startValue) * tween + startValue;
		} else if (type === 'string') {
			const [colorSystem, startComponents] = parseColor(startValue);
			const [, endComponents] = parseColor(endValue);
			const tweened = new Array(4);
			for (let i = 0; i < 4; i++) {
				const componentStart = startComponents[i];
				const componentEnd = endComponents[i];
				tweened[i] = (componentEnd - componentStart) * tween + componentStart;
			}
			if (colorSystem === 'rgb') {
				return 'rgba(' + tweened.join(', ') + ')';
			} else {
				return hsla(...tweened);
			}
		}
	}

	function interpolateStep(startValue, endValue, tween, loop) {
		if (!loop && (tween === 1 || startValue === endValue)) {
			return endValue;
		} else if (Array.isArray(startValue)) {
			const numStartComponents = startValue.length;
			const numEndComponents = endValue.length;
			const numComponents = Math.min(numStartComponents, numEndComponents);
			const output = new Array(numComponents);
			for (let i = 0; i < numComponents; i++) {
				output[i] = interpolateStep(startValue[i], endValue[i], tween, loop);
			}
			const maxIndex = interpolateStep(numStartComponents, numEndComponents, tween, loop);
			if (numStartComponents > numEndComponents) {
				for (let i = numEndComponents; i < maxIndex; i++) {
					output[i] = startValue[i];
				}
			} else if (numEndComponents > numStartComponents) {
				for (let i = numStartComponents; i < maxIndex; i++) {
					output[i] = endValue[i];
				}
			}
			return output;
		} else if (typeof(startValue) === 'number') {
			let steps = endValue - startValue;
			if (loop) {
				if (tween <= 0.5) {
					return Math.floor(steps * tween * 2 + startValue);
				} else {
					return Math.ceil(steps * (1 - (tween - 0.5) * 2) + startValue);
				}
			} else {
				if (steps > 0) {
					return Math.floor((steps + 1) * tween + startValue);
				} else {
					// End value smaller than start value
					return Math.ceil((steps - 1) * tween + startValue);
				}
			}
		} else {
			return tween < 0.5 ? startValue : endValue;
		}
	}

	function interpolatePair(startValue1, endValue1, startValue2, endValue2, interpolate, tween) {
		let value1, value2;
		if (Array.isArray(startValue1)) {
			value1 = []; value2 = [];
			const numComponents1 = startValue1.length;
			const numComponents2 = startValue2.length;
			const numComponents = Math.min(numComponents1, numComponents2);
			const output = new Array(numComponents);
			for (let i = 0; i < numComponents; i++) {
				const start1 = startValue1[i];
				const end1 = endValue1[i];
				const start2 = startValue2[i]
				const end2 = endValue2[i];
				if (i >= endValue1.length) {
					value2[i] = interpolate(start2, end2, tween, true);
				} else if (i >= endValue2.length) {
					value1[i] = interpolate(start1, end1, tween, true);
				} else {
					[value1[i], value2[i]] = interpolatePair(start1, end1, start2, end2, interpolate, tween);
				}
			}
			const numEndComponents1 = endValue1.length;
			const numEndComponents2 = endValue2.length;
			if (numComponents1 > numComponents2) {
				for (let i = numComponents2; i < numComponents1 && i < numEndComponents1; i++) {
					value1[i] = interpolate(startValue1[i], endValue1[i], tween, true);
				}
			} else if (numComponents2 > numComponents1) {
				for (let i = numComponents1; i < numComponents2 && i < numEndComponents2; i++) {
					value2[i] = interpolate(startValue2[i], endValue2[i], tween, true);
				}
			}
			for (let i = value1.length; i < numEndComponents1; i++) {
				value1[i] = endValue1[i];
			}
			for (let i = value2.length; i < numEndComponents2; i++) {
				value2[i] = endValue2[i];
			}
		} else {
			if (startValue1 === startValue2) {
				value1 = endValue1;
				value2 = interpolate(endValue2, endValue1, (tween - 0.5) * 2, false);
			} else {
				value1 = interpolate(startValue1, endValue1, tween, true);
				value2 = interpolate(startValue2, endValue2, tween, true);
			}
		}
		return [value1, value2];
	}

	function interpolatePairs(pairProperty, stepped, tween, loop) {
		if (!(pairProperty in bgGenerator.animatable)) {
			return;
		}
		const interpolate = stepped ? interpolateStep : interpolateValue;
		if (!loop || tween <= 0.5) {
			for (let [property1, property2] of bgGenerator.animatable[pairProperty]) {
				const startValue1 = startFrame[pairProperty].get(property1);
				const endValue1 = endFrame[pairProperty].get(property1);
				bgGenerator[property1] = interpolate(startValue1, endValue1, tween, loop);
				const startValue2 = startFrame[pairProperty].get(property2);
				const endValue2 = endFrame[pairProperty].get(property2);
				bgGenerator[property2] = interpolate(startValue2, endValue2, tween, loop);
			}
		} else {
			for (let [property1, property2] of bgGenerator.animatable[pairProperty]) {
				const startValue1 = startFrame[pairProperty].get(property1);
				const endValue1 = endFrame[pairProperty].get(property1);
				const startValue2 = startFrame[pairProperty].get(property2);
				const endValue2 = endFrame[pairProperty].get(property2);
				const [value1, value2] = interpolatePair(startValue1, endValue1, startValue2, endValue2, interpolate, tween);
				bgGenerator[property1] = value1;
				bgGenerator[property2] = value2;
			}
		}
	}

	function interpolateBackgroundImage(startImage, endImage, context, tween, loop) {
		const hasStartImage = startImage !== undefined;
		const hasEndImage = endImage !== undefined;
		const canvas = context.canvas;
		const dWidth = canvas.width;
		const dHeight = canvas.height;
		if (loop) {
			tween = 1 - 2 * (tween - 0.5);
		}
		const startFade = 0.3;
		const endFade = 0.7;
		if (tween <= startFade) {
			if (hasStartImage) {
				context.drawImage(startImage, 0, 0, dWidth, dHeight);
			}
		} else if (tween < endFade) {
			const fadeAmount = (endFade - tween)  / (endFade - startFade);
			if (hasEndImage) {
				if (!hasStartImage) {
					context.globalAlpha = 1 - fadeAmount;
				}
				context.drawImage(endImage, 0, 0, dWidth, dHeight);
			}
			if (hasStartImage) {
				context.globalAlpha = fadeAmount;
				context.drawImage(startImage, 0, 0, dWidth, dHeight);
			}
		} else {
			if (hasEndImage) {
				context.drawImage(endImage, 0, 0, dWidth, dHeight);
			}
		}
	}


	class NominalArrayInterpolator {

		constructor (startValue, endValue) {
			const toSet = [];
			const toClear = [];
			const numStart = startValue.length;
			const numEnd = endValue.length;
			let minLength;
			if (numStart >= numEnd) {
				this.numDelete = numStart - numEnd;
				this.numAdd = 0;
				minLength = numEnd;
			} else {
				this.numDelete = 0;
				this.numAdd = numEnd - numStart;
				minLength = numStart;
			}
			const truthy = startValue[0] || endValue[0] || true;
			let lastSet;
			for (let i = 0; i < minLength; i++) {
				const initiallyOn = startValue[i] == truthy;
				const finallyOn = endValue[i] == truthy;
				if (finallyOn && !initiallyOn) {
					toSet.push(i);
					lastSet = i;
				} else if (startValue[i] !== endValue[i]) {
					toClear.push(i);
				}
			}
			this.toSet = toSet;
			this.toClear = toClear;
		}

		interpolate(startValue, endValue, tween, loop) {
			let numAdd = this.numAdd;
			let numDelete = this.numDelete;
			let initialArray = startValue, finalArray = endValue;
			let reverse = false;
			if (loop) {
				if (tween > 0.5) {
					tween -= 0.5;
					reverse = true;
					numAdd = this.numDelete;
					numDelete = this.numAdd;
					initialArray = endValue;
					finalArray = startValue;
				}
				tween *= 2;
			}

			const toSet = this.toSet;
			const toClear = this.toClear;
			const numSteps = numDelete + numAdd + toSet.length + toClear.length;
			let step = Math.trunc((numSteps + 1) * tween);
			let value;

			// Handle deletions first
			const numDelete2 = Math.min(numDelete, step);
			if (!reverse && numDelete2 > 0) {
				value = initialArray.slice(0, -numDelete2);
				step -= numDelete2;
			} else {
				value = initialArray.slice();
			}

			// Handle insertions next when in the forward stage of a loop
			const startLength = value.length;
			if (loop && !reverse) {
				numAdd = Math.min(numAdd, step);
				const currentLength = startLength + numAdd;
				for (let i = startLength; i < currentLength; i++) {
					value[i] = endValue[i];
				}
				step -= numAdd;
			}

			// Handle setting values to true when going forward / clearing when looping back
			const numSet = Math.min(step, toSet.length);
			for (let i = 0; i < numSet; i++) {
				const index = toSet[i];
				value[index] = finalArray[index];
			}
			step -= numSet;

			// Handle clearing values when going forward / setting to true when looping back
			const numClear = Math.min(step, toClear.length);
			for (let i = 0; i < numClear; i++) {
				const index = toClear[i];
				value[index] = finalArray[index];
			}

			// Handle insertions last if not looping and changes in length last when going in the
			// reverse direction
			if (!loop || reverse) {
				step -= numClear;

				const currentLength = startLength + Math.min(numAdd, step);
				for (let i = startLength; i < currentLength; i++) {
					value[i] = finalArray[i];
				}
				if (reverse) {
					numDelete = Math.min(numDelete, step);
					value.splice(currentLength - numDelete, numDelete);
				}
			}

			return value;
		}

	}

	class TweenData {

		constructor(generator, startFrame, endFrame, width, height) {

			this.backgroundColorVaries = startFrame.backgroundColor !== endFrame.backgroundColor;

			this.blurVaries = startFrame.blur !== endFrame.blur;

			this.calcSize(startFrame, endFrame, width, height);

			// XY: Map x property name to the calculated value.
			this.radii = new Map();
			this.startTheta = new Map();
			this.centreX1 = new Map();
			this.centreY1 = new Map();
			this.centreX2 = new Map();
			this.centreY2 = new Map();

			this.nominalArrays = new Map();

			const animatable = generator.animatable;
			if (animatable === undefined) {
				return;
			}

			if (animatable.xy !== undefined) {
				const startXY = startFrame.xy;
				const endXY = endFrame.xy;

				for (let [keyX, keyY] of animatable.xy) {
					const startX = startXY.get(keyX);
					const startY = startXY.get(keyY);
					const endX = endXY.get(keyX);
					const endY = endXY.get(keyY);
					const centreX1 = (startX + 3 * endX) / 4;
					const centreY1 = (startY + 3 * endY) / 4;
					const centreX2 = (3 * startX + endX) / 4;
					const centreY2 = (3 * startY + endY) / 4;
					const distX = endX - startX;
					const distY = endY - startY;
					const r = Math.hypot(distX, distY) / 4;
					const theta = Math.atan2(distY, distX);
					this.radii.set(keyX, r);
					this.startTheta.set(keyX, theta);
					this.centreX1.set(keyX, centreX1);
					this.centreY1.set(keyX, centreY1);
					this.centreX2.set(keyX, centreX2);
					this.centreY2.set(keyX, centreY2);
				}
			}

			if (animatable.nominalArray !== undefined) {
				for (let key of animatable.nominalArray) {
					const startValue = startFrame.nominalArrays.get(key);
					const endValue = endFrame.nominalArrays.get(key);
					const interpolator = new NominalArrayInterpolator(startValue, endValue);
					this.nominalArrays.set(key, interpolator);
				}
			}
		}

		calcSize(startFrame, endFrame, width, height) {
			[this.startWidth, this.startHeight] = calcSize(width, height, startFrame.scale, startFrame.scaleMode);
			[this.endWidth, this.endHeight] = calcSize(width, height, endFrame.scale, endFrame.scaleMode);
		}

		interpolateXY(keyX, tween) {
			const r = this.radii.get(keyX);
			const startTheta = this.startTheta.get(keyX);
			let centreX, centreY, theta;
			if (tween < 0.75) {
				centreX = this.centreX1.get(keyX);
				centreY = this.centreY1.get(keyX);
				theta = 4 * (tween - 0.5) * Math.PI + startTheta;
			} else {
				centreX = this.centreX2.get(keyX);
				centreY = this.centreY2.get(keyX);
				theta = -4 * (tween - 0.75) * Math.PI + startTheta;
			}
			const x = r * Math.cos(theta) + centreX;
			const y = r * Math.sin(theta) + centreY;
			return [x, y];
		}

		interpolateNominalArrays(generator, startFrame, endFrame, tween, loop) {
			for (let [key, interpolator] of this.nominalArrays.entries()) {
				const startValue = startFrame.nominalArrays.get(key);
				const endValue = endFrame.nominalArrays.get(key);
				const value = interpolator.interpolate(startValue, endValue, tween, loop);
				generator[key] = value;
			}
		}

	}

	function calcTweenData() {
		const hasStartImage = startFrame.backgroundImage !== undefined;
		const hasEndImage = endFrame.backgroundImage !== undefined;
		if (hasStartImage !== hasEndImage) {
			let imageFrame, colorFrame;
			if (hasStartImage) {
				imageFrame = startFrame;
				colorFrame = endFrame;
			} else {
				imageFrame = endFrame;
				colorFrame = startFrame;
			}
			const [r, g, b] = parseColor(colorFrame.backgroundColor)[1];
			const color = rgbToLuma(r, g, b) >= 0.5 ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
			imageFrame.backgroundColor = color;
			if (currentFrame === imageFrame) {
				backgroundElement.style.backgroundColor = color;
			}
		}

		tweenData = new TweenData(bgGenerator, startFrame, endFrame, canvas.width, canvas.height);
		backgroundElement.style.willChange = tweenData.backgroundColorVaries ? 'background-color' : 'auto';
	}

	class InterpolatedRandom {
		constructor(startGenerator, endGenerator, tween) {
			this.startGenerator = startGenerator;
			this.endGenerator = endGenerator;
			this.tween = tween;
			this.seed = startGenerator.seed + '\n' + endGenerator.seed;
		}

		next() {
			const tween = this.tween;
			return (1 - tween) * this.startGenerator.next() + tween * this.endGenerator.next();
		}

		reset() {
			this.startGenerator.reset();
			this.endGenerator.reset();
		}
	}

	function interpolateRandom(startGenerator, endGenerator, tween) {
		switch (tween) {
		case 0:
			random = startGenerator;
			break;
		case 1:
			random = endGenerator;
			break;
		default:
			if (startGenerator === endGenerator) {
				random = startGenerator;
			} else {
				random = new InterpolatedRandom(startGenerator, endGenerator, tween);
			}
		}
	}

	const tempCanvas = document.createElement('CANVAS');
	const tempContext = tempCanvas.getContext('2d');

	function applyFilter(context, filter, width, height) {
		tempCanvas.width = context.canvas.width;
		tempCanvas.height = context.canvas.height;
		tempContext.drawImage(context.canvas, 0, 0);
		context.filter = filter;
		// width and height are not superfluous because the canvas is scaled
		context.drawImage(tempCanvas, 0, 0, width, height);
		context.filter = '';
	}

	function renderFrame(generator, contextualInfo, width, height, tween, loop, paintBackground, preview, forAnim) {
		const tweenPrime = calcTween(tween, loop);
		for (let property of startFrame.continuous.keys()) {
			const startValue = startFrame.continuous.get(property);
			const endValue = endFrame.continuous.get(property);
			generator[property] = interpolateValue(startValue, endValue, tweenPrime, false);
		}
		for (let property of startFrame.stepped.keys()) {
			const startValue = startFrame.stepped.get(property);
			const endValue = endFrame.stepped.get(property);
			generator[property] = interpolateStep(startValue, endValue, tween, loop);
		}
		const animatable = generator.animatable;
		if (startFrame !== endFrame && animatable !== undefined) {
			interpolatePairs('pairedContinuous', false, tween, loop);
			interpolatePairs('pairedStepped', true, tween, loop);

			const xy = animatable.xy;
			if (xy !== undefined) {
				if (loop) {
					if (tween <= 0.5) {
						for (let property of startFrame.xy.keys()) {
							const startValue = startFrame.xy.get(property);
							const endValue = endFrame.xy.get(property);
							generator[property] = interpolateValue(startValue, endValue, tween, true);
						}
					} else {
						for (let [propertyX, propertyY] of xy) {
							const [x, y] = tweenData.interpolateXY(propertyX, tween);
							generator[propertyX] = x;
							generator[propertyY] = y;
						}
					}
				} else {
					for (let property of startFrame.xy.keys()) {
						const startValue = startFrame.xy.get(property);
						const endValue = endFrame.xy.get(property);
						generator[property] = interpolateValue(startValue, endValue, tween, false);
					}
				}

			}

			tweenData.interpolateNominalArrays(generator, startFrame, endFrame, tween, loop);
		}
		if ('tween' in generator) {
			generator.tween = tweenPrime;
		}

		const startRotation = startFrame.rotation;
		let endRotation = endFrame.rotation;
		const loopedRotation = loop && (endRotation - startRotation) % TWO_PI !== 0;
		endRotation += (endRotation < startRotation ? -1 : 1) * TWO_PI * fullRotations;
		const rotation = interpolateValue(startRotation, endRotation, tween, loopedRotation);
		interpolateRandom(startFrame.random, endFrame.random, tweenPrime);

		let backgroundColor;
		if (tweenData.backgroundColorVaries) {
			backgroundColor = interpolateValue(startFrame.backgroundColor, endFrame.backgroundColor, tweenPrime, false);
			backgroundElement.style.backgroundColor = backgroundColor;
		} else {
			backgroundColor = startFrame.backgroundColor;
		}

		const context = contextualInfo.twoD;
		restoreCanvas(context);
		const renderWidth = interpolateValue(tweenData.startWidth, tweenData.endWidth, tweenPrime, false);
		const renderHeight = interpolateValue(tweenData.startHeight, tweenData.endHeight, tweenPrime, false);
		const blur = interpolateValue(startFrame.blur, endFrame.blur, tweenPrime, false);
		let needDrawSignature = paintBackground || (!forAnim && preview === 0);
		context.globalAlpha = interpolateValue(startFrame.opacity, endFrame.opacity, tweenPrime, false);
		context.clearRect(0, 0, width, height);
		transformCanvas(context, width, height, renderWidth, renderHeight, rotation);

		function postDraw(contextualInfo) {
			context.globalCompositeOperation = 'destination-over';
			interpolateBackgroundImage(startFrame.backgroundImage, endFrame.backgroundImage, context, tween, loop);
			if (paintBackground) {
				context.fillStyle = backgroundColor;
				context.fillRect(0, 0, width, height);
				context.fillStyle = 'black';
				if (blur > 0.4) {
					context.globalCompositeOperation = 'source-over';
					applyFilter(context, calcBlur(blur), width, height);
				}
			} else if (tweenData.blurVaries) {
				context.canvas.style.filter = calcBlur(blur);
			}
			context.globalCompositeOperation = 'source-over';
			if (needDrawSignature) {
				drawSignature(contextualInfo, true);
			}
		}

		if (generator.isShader) {
			contextualInfo.setProperties(generator);
			contextualInfo.drawGL(tweenPrime, preview);
			restoreCanvas(context);
			postDraw(contextualInfo)
		} else if (forAnim) {
			// Draw everything in one go when capturing video
			random.reset();
			const redraw = generator.generate(context, renderWidth, renderHeight, preview);
			let done;
			do {
				yieldTime = performance.now() + redrawInterval;
				unitsProcessed = 0;
				done = redraw.next().done;
			} while (!done);
			restoreCanvas(context);
			postDraw(contextualInfo);
		} else {
			progressiveBackgroundDraw(generator, contextualInfo, renderWidth, renderHeight, preview, postDraw);
		}
	}

	function animate(generator, contextualInfo, width, height, startTween, length, loop, preview, capturer) {
		const canvas = contextualInfo.twoD.canvas;
		const paintBackground = capturer !== undefined;
		const newAnimController = new AnimationController({startTween: startTween});
		const promise = new Promise(function (resolve, reject) {
			const indicator = document.getElementById('recording-indicator');
			let framesRendered = 0;
			let uiUpdateInterval = 1 / animPositionSlider.clientWidth;
			if (!Number.isFinite(uiUpdateInterval)) {
				uiUpdateInterval = 1 / 30;
			}

			function render(time) {
				if (capturer !== undefined) {
					time = performance.now();
				} else if (time - newAnimController.previousTime > 400) {
					console.log("Slow render!");
				}
				newAnimController.previousTime = time;

				const startTween = newAnimController.startTween;
				let beginTime = newAnimController.beginTime;
				if (beginTime === undefined) {
					beginTime = time;
					newAnimController.lastUIUpdate = startTween;
					newAnimController.setup(render, reject, beginTime);
				}

				if (newAnimController.status !== AnimationController.Status.RUNNING) {
					return;
				}
				let tween = startTween + (time - beginTime) / length;
				const lastFrame = tween >= 1;
				if (lastFrame) {
					tween = 1;
				}
				renderFrame(generator, contextualInfo, width, height, tween, loop, paintBackground, preview, true);
				newAnimController.progress = tween;

				if (capturer !== undefined) {
					capturer.capture(canvas);
					let percent = (tween - startTween) / (1 - startTween) * 100;
					progressBar.style.width = percent + '%';
					percent = Math.trunc(percent);
					progressBar.innerHTML = percent + '%';
					progressBar.setAttribute('aria-valuenow', percent);
					framesRendered++;
					const iconFile = framesRendered % 2 === 0 ? 'img/record.png' : 'img/draw_ellipse.png';
					indicator.src = iconFile;
				} else if (animControlsOpen && tween - newAnimController.lastUIUpdate >= uiUpdateInterval) {
					animPositionSlider.value = tween;
					newAnimController.lastUIUpdate = tween;
				}
				if (lastFrame) {
					newAnimController.finish(resolve);
				} else {
					requestAnimationFrame(render);
				}
			};
			newAnimController.progress = 0;
			newAnimController.start = function () {
				const time = performance.now();
				this.previousTime = time;
				render(time);
			}
		});
		newAnimController.promise = promise;
		return newAnimController;
	}

	async function captureVideo(contextualInfo, width, height, length, properties) {
		const renderButton = document.getElementById('btn-render-video');
		renderButton.disabled = true;
		const closeWidget = document.getElementById('video-modal').querySelector('.close');
		closeWidget.hidden = true;
		progressBar.style.width = '0';
		progressBar.innerHTML = '0%';
		progressBar.setAttribute('aria-valuenow', '0');
		const progressRow = document.getElementById('video-progress-row');
		progressRow.classList.remove('invisible');

		// Generate audio to prevent background page CPU throttling.
		const audioContext = new AudioContext();
		let constantNode = audioContext.createConstantSource();
		const gainNode = audioContext.createGain();
		gainNode.gain.value = 0.001;
		constantNode.connect(gainNode);
 		gainNode.connect(audioContext.destination);
 		constantNode.start();

		const pauseButton = document.getElementById('btn-pause-video-render');
		function pauseResumeRendering(event) {
			const paused = animController.status === AnimationController.Status.PAUSED;
			if (paused) {
				animController.continue();
				this.children[0].src = 'img/control_pause.png';
				this.childNodes[1].textContent = 'Pause';
				constantNode = audioContext.createConstantSource();
				constantNode.connect(gainNode);
				constantNode.start();
			} else {
				animController.pause();
				this.children[0].src = 'img/file_start_workflow.png';
				this.childNodes[1].textContent = 'Resume';
				constantNode.stop();
				constantNode.disconnect();
			}
		};
		pauseButton.children[0].src = 'img/control_pause.png';
		pauseButton.childNodes[1].textContent = 'Pause';
		pauseButton.addEventListener('click', pauseResumeRendering);
		pauseButton.hidden = false;

		const downloads =  [];
		if (imageFormats.has('webp')) {
			downloads.push(requireScript('lib/CCapture.webm.min.js'));
		} else {
			downloads.push(requireScript('lib/CCapture.mjpg.min.js'));
		}
		if (properties.format !== 'webm' && properties.format !== 'mjpg') {
			downloads.push(requireScript('lib/tar.min.js'));
		}

		await Promise.all(downloads);
		const capturer = new CCapture(properties);
		animController = animate(bgGenerator, contextualInfo, width, height, 0, length, loopAnim, 0, capturer);
		const stopButton = document.getElementById('btn-cancel-video-render');
		stopButton.innerHTML = 'Abort';
		stopButton.classList.add('btn-danger');
		stopButton.classList.remove('btn-secondary');

		let notification;

		function promptSave() {
			document.removeEventListener('visibilitychange', promptSave);
			if (notification !== undefined) {
				notification.close();
			}
			capturer.save();
			capturer.stop();
		}

		function reset() {
			audioContext.close();
			pauseButton.hidden = true;
			pauseButton.removeEventListener('click', pauseResumeRendering);
			stopButton.innerHTML = 'Close';
			stopButton.classList.add('btn-secondary');
			stopButton.classList.remove('btn-danger');
			progressRow.classList.add('invisible');
			closeWidget.hidden = false;
			renderButton.disabled = false;
			if (debug.video) {
				document.body.removeChild(contextualInfo.twoD.canvas);
				canvas.hidden = false;
			}
			animController = undefined;
		}

		animController.promise = animController.promise.then(
			function () {
				$('#video-modal').modal('hide');
				if (document.hidden) {
					document.addEventListener('visibilitychange', promptSave);
					if (window.Notification && Notification.permission === 'granted' &&
						document.getElementById('notify-video-render').checked
					) {
						notification = new Notification('Mathematical Art With Elizabeth', {
							body: 'Your video is ready. Click here or return to the app to save it.',
							silent: true,
						});
						notification.onclick = function (event) {
							event.preventDefault();
							promptSave();
						};
					}
				} else {
					promptSave();
				}
				reset();
			},
			function () {
				capturer.stop();
				reset();
			}
		);

		capturer.start();
		animController.start();
	}

	function generateFilename() {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, '0');
		const day = String(now.getDate()).padStart(2, '0');
		const hour = String(now.getHours()).padStart(2, '0');
		const minute = String(now.getMinutes()).padStart(2, '0');
		const generatorName = generatorURL.match(/(^|\/)([\w\-.]+)\.js$/)[2];
		return `${generatorName} ${year}-${month}-${day} ${hour}${minute}`;
	}

	seedInput.value = random.seed;

	if (document.fullscreenEnabled) {
		document.getElementById('btn-full-screen').addEventListener('click', function (event) {
			if (document.fullscreenElement === null) {
				document.documentElement.requestFullscreen({navigationUI: 'hide'});
			} else {
				document.exitFullscreen();
			}
		});
	} else {
		document.getElementById('btn-full-screen').hidden = true;
	}

	if (store !== undefined) {
		document.getElementById('show-welcome').addEventListener('input', function (event) {
			try {
				store.setItem('no-welcome', !this.checked);
			} catch (e) {
				console.warn(e);
			}
		});
	}

	document.getElementById('btn-what-is-this').addEventListener('click', function (event) {
		if (helpContextItem !== undefined) {
			helpContextItem.popover('dispose');
		}

		document.body.classList.add('cursor-help');
		helpContext = true;
		helpContextItem = $(this);
		helpContextItem.popover({
			animation: false,
			content: 'Now click on the item you\'d like help with.',
			placement: 'left',
			trigger: 'manual',
		});
		helpContextItem.popover('show');
	});

	document.body.addEventListener('click', function (event) {
		if (helpContextIntermediate) {
			event.preventDefault();
			helpContextIntermediate = false;
		}
	});

	document.body.addEventListener('mousedown', function (event) {
		let target = event.target;
		if (target.tagName === 'LABEL' && target.control !== null) {
			target = target.control;
		}

		if (helpContextItem !== undefined) {
			if (helpContextItem.get(0).contains(target)) {
				return;
			}
			helpContextItem.popover('dispose');
			helpContextItem = undefined;
		}

		if (helpContext) {
			let popoverTitle = '';
			let popoverContent = null;
			document.body.classList.remove('cursor-help');
			helpContext = false;

			const rootElement = document.body;
			do {
				if (target.tagName === 'A') {
					return;
				}
				if ('labels' in target && target.labels.length > 0) {
					popoverTitle = target.labels[0].innerText;
				} else if ('reset' in target.dataset) {
					const resetTarget = document.getElementById(target.dataset.reset);
					const resetLabel = resetTarget.labels[0].innerText;
					popoverContent = 'Resets the ' + resetLabel + ' control to it\'s initial setting.';
					popoverTitle = 'Reset ' + resetLabel;
					break;
				} else if (target.title) {
					popoverTitle = target.title;
				}
				let id = target.id;
				if (id) {
					if (helpDoc !== undefined) {
						popoverContent = helpDoc.getElementById(id);
					}
					if (popoverContent !== null) {
						popoverContent = popoverContent.cloneNode(true);
						popoverContent.removeAttribute('id');
						break;
					}
				}
				target = target.parentElement;
			} while (target !== rootElement);

			event.preventDefault();
			if (popoverContent === null) {
				popoverTitle = 'No Help Available';
				popoverContent = 'Sorry, no help is available for this item.';
			} else {
				if (target.type === 'radio') {
					const groupNameWords = target.name.split('-');
					capitalize(groupNameWords);
					popoverTitle = popoverTitle + ' ' + groupNameWords.join(' ');

				} else if (popoverTitle === '') {

					const groupNameWords = target.id.split('-').slice(1);
					capitalize(groupNameWords);
					popoverTitle = groupNameWords.join(' ');
				}
			}

			target = event.target;
			const targetTitle = target.title;
			const popoverHeader = document.createElement('DIV');
			const titleSpan = document.createElement('SPAN');
			titleSpan.classList.add('d-inline-block', 'mt-1');
			titleSpan.innerHTML = popoverTitle;
			popoverHeader.appendChild(titleSpan);
			const closeButton = document.createElement('BUTTON');
			closeButton.classList.add('close');
			closeButton.innerHTML = '&times;';
			popoverHeader.appendChild(closeButton);

			target.removeAttribute('title');
			helpContextItem = $(target);
			helpContextItem.popover({
				animation: false,
				content: popoverContent,
				html: true,
				offset: '[0, 20]',
				placement: 'auto',
				title: popoverHeader,
				trigger: 'manual',
				boundary: 'viewport'
			});
			helpContextItem.popover('show');
			target.title = targetTitle;
			helpContextIntermediate = true;
		}
	});

	function showAuthorForm(event) {
		authorForm.hidden = false;
		authorInput.focus();
	}

	signatureBox.addEventListener('click', showAuthorForm);
	signatureBox.addEventListener('mouseenter', showAuthorForm);

	authorForm.addEventListener('submit', function (event) {
		event.preventDefault();
		this.hidden = true;
		userDisplayName = authorInput.value;
		signatureChanged = true;
		progressiveBackgroundGen(0);
	});

	authorForm.addEventListener('focusout', function (event) {
		if (!this.contains(event.relatedTarget)) {
			authorForm.hidden = true;
			if (userDisplayName !== undefined) {
				authorInput.value = userDisplayName;
			}
		}
	});

	document.getElementById('background-preset').addEventListener('input', function (event) {
		const value = this.value;
		if (value === 'color') {
			$('#background-color-row').collapse('show');
			backgroundImage = undefined;
			const [r, g, b] = parseColor(backgroundElement.style.backgroundColor)[1];
			const color = rgbToHex(r, g, b);
			document.getElementById('background-color').value = color;
			progressiveBackgroundGen(0);
		} else {
			$('#background-color-row').collapse('hide');
			backgroundImage = document.createElement('IMG');
			backgroundImage.onload = redraw;
			backgroundImage.src = 'img/texture/' + value + '.jpg';
		}
	});

	// Changing background colour.
	document.getElementById('background-color').addEventListener('input', function (event) {
		backgroundElement.style.backgroundColor = this.value;
		drawSignatureWhenReady(drawingContext, false);
	});

	opacitySlider.addEventListener('input', function (event) {
		opacity = parseFloat(this.value);
		progressiveBackgroundGen(1, drawBackgroundImage);
	});

	function opacityListener(event) {
		opacity = parseFloat(this.value);
		progressiveBackgroundGen(0);
	}

	opacitySlider.addEventListener('pointerup', opacityListener);
	opacitySlider.addEventListener('keyup', opacityListener);

	rotationSlider.addEventListener('input', function (event) {
		rotation = TWO_PI * parseFloat(this.value);
		progressiveBackgroundGen(1, drawBackgroundImage);
	});

	function rotationListener(event) {
		rotation = TWO_PI * parseFloat(this.value);
		progressiveBackgroundGen(0);
	}

	rotationSlider.addEventListener('pointerup', rotationListener);
	rotationSlider.addEventListener('keyup', rotationListener);

	document.getElementById('layer-rotation-reset').addEventListener('click', function (event) {
		rotationSlider.value = 0;
		rotation = 0;
		progressiveBackgroundGen(0);
	});

	function setScaleMode(event) {
		scaleMode = parseInt(this.value);
		progressiveBackgroundGen(0);
	}

	for (let element of document.getElementById('rotation-sizing-row').getElementsByTagName('INPUT')) {
		element.addEventListener('input', setScaleMode);
	}

	scaleSlider.addEventListener('input', function (event) {
		scale = parseFloat(this.value);
		progressiveBackgroundGen(1, drawBackgroundImage);
	});

	function scaleListener(event) {
		scale = parseFloat(this.value);
		progressiveBackgroundGen(0);
	}

	scaleSlider.addEventListener('pointerup', scaleListener);
	scaleSlider.addEventListener('keyup', scaleListener);

	blurSlider.addEventListener('input', function (event) {
		blur = parseFloat(this.value);
		canvas.style.filter = calcBlur(blur);
	});

	document.getElementById('btn-open-sketch').addEventListener('click', function (event) {
		const sketchesModal = document.getElementById('sketches-modal');
		$(sketchesModal).modal('hide');
		$(modal).modal('show');
		currentSketch = inputsToSketches.get(queryChecked(sketchesModal, 'sketch'));
		const url = currentSketch.url;
		if (/\.html$/.test(url)) {
			document.location = new URL(url, document.location);
		} else {
			switchGenerator(currentSketch.url, true);
		}
	});

	// Generate new background button.
	document.getElementById('btn-generate-background').addEventListener('click', function (event) {
		document.getElementById('overlay').classList.remove('show');
		random = new RandomNumberGenerator();
		seedInput.value = random.seed;
		progressiveBackgroundGen(0);
	});

	function parseSeed(seed) {
		if (seed === undefined) {
			seed = seedInput.value;
		}
		seed = seed.replace(/\r/g, '');
		const match = seed.match(/(\d+\n\d+\n\d+\n\d+)(?:\n(\d+\n\d+\n\d+\n\d+))?/);
		if (match !== null) {
			if (match[2] === undefined) {
				random = new RandomNumberGenerator(seed);
			} else {
				const startGenerator = new RandomNumberGenerator(match[1]);
				startFrame.random = startGenerator;
				if (match[2] === match[1]) {
					endFrame.random = startGenerator;
					random = startGenerator;
				} else {
					const endGenerator = new RandomNumberGenerator(match[2]);
					if (startFrame === endFrame) {
						// Create start and end frames that differ only because they use different random numbers.
						endFrame = currentFrameData();
						calcTweenData();
					}
					endFrame.random = endGenerator;
					const tween = calcTween(parseFloat(animPositionSlider.value), loopAnim);
					interpolateRandom(startGenerator, endGenerator, tween);
					currentFrame.random = random;
				}
			}
			progressiveBackgroundGen(0);
		}
	}

	seedInput.addEventListener('focus', function (event) {
		this.select();
	});

	seedInput.addEventListener('paste', function (event) {
		parseSeed(event.clipboardData.getData('text/plain'));
	});

	seedForm.addEventListener('focusout', function (event) {
		if (!this.contains(event.relatedTarget)) {
			parseSeed();
		}
	});

	seedForm.addEventListener('submit', function (event) {
		event.preventDefault();
		parseSeed();
	});

	$('#generate-btn-group').on('shown.bs.dropdown', function (event) {
		seedInput.focus();
	});

	$('#generate-btn-group').on('hide.bs.dropdown', function(event) {
		const target = document.activeElement;
		return target !== document.getElementById('btn-generate-background') && !seedForm.contains(target);
	});

	// Animation controls
	document.getElementById('btn-start-frame').addEventListener('click', function (event) {
		document.getElementById('overlay').classList.remove('show');
		random = random.startGenerator;
		currentFrame = currentFrameData();
		startFrame = currentFrame;
		calcTweenData();
		displaySeed();
		animPositionSlider.value = 0;
		updateAnimPositionReadout(0);
		if ('tween' in bgGenerator) {
			bgGenerator.tween = 0;
			progressiveBackgroundGen(0);
		}
		showAlert(successAlert, 'Start frame set.', document.body)
		videoErrorAlert.alert('close');
	});

	document.getElementById('btn-start-frame2').addEventListener('click', function (event) {
		random = random.startGenerator;
		startFrame = currentFrameData();
		calcTweenData();
		displaySeed();
		animAction();
	});

	document.getElementById('btn-end-frame').addEventListener('click', function (event) {
		document.getElementById('overlay').classList.remove('show');
		random = random.endGenerator;
		currentFrame = currentFrameData();
		endFrame = currentFrame;
		calcTweenData();
		displaySeed();
		animPositionSlider.value = 1;
		updateAnimPositionReadout(1);
		if ('tween' in bgGenerator) {
			bgGenerator.tween = 1;
			progressiveBackgroundGen(0);
		}
		showAlert(successAlert, 'End frame set.', document.body)
		videoErrorAlert.alert('close');
	});

	document.getElementById('btn-end-frame2').addEventListener('click', function (event) {
		random = random.endGenerator;
		endFrame = currentFrameData();
		calcTweenData();
		displaySeed();
		animAction();
	});

	document.getElementById('btn-both-frames').addEventListener('click', function (event) {
		document.getElementById('overlay').classList.remove('show');
		const tween = parseFloat(animPositionSlider.value);
		if (loopAnim) {
			random = tween < 0.25 || tween > 0.75 ? random.startGenerator : random.endGenerator;
		} else {
			random = tween < 0.5 ? random.startGenerator : random.endGenerator;
		}
		currentFrame = currentFrameData();
		startFrame = currentFrame;
		endFrame = currentFrame;
		calcTweenData();
		seedInput.value = random.seed;
		showAlert(successAlert, 'Both frames set.', document.body);
	});

	document.getElementById('btn-both-frames2').addEventListener('click', function (event) {
		const tween = parseFloat(animPositionSlider.value);
		if (loopAnim) {
			random = tween < 0.25 || tween > 0.75 ? random.startGenerator : random.endGenerator;
		} else {
			random = tween < 0.5 ? random.startGenerator : random.endGenerator;
		}
		currentFrame = currentFrameData();
		startFrame = currentFrame;
		endFrame = currentFrame;
		calcTweenData();
		seedInput.value = random.seed;
		animAction();
	});

	document.getElementById('btn-bg-change-discard').addEventListener('click', function (event) {
		const tween = parseFloat(animPositionSlider.value);
		random = interpolateRandom(startFrame.random, endFrame.random, calcTween(tween, loopAnim));
		renderFrame(bgGenerator, drawingContext, canvas.width, canvas.height, tween, loopAnim, false, 0, false);
		currentFrame = currentFrameData();
		animAction();
	});

	function updateAnimPositionReadout(tween) {
		let timeStr;
		const length = parseFloat(document.getElementById('anim-length').value);
		if (length > 0) {
			let time = tween * length;
			if (length <= 60) {
				time = Math.round(time * 10) / 10;
			} else {
				time = Math.round(time);
			}
			timeStr = time + 's';
		} else {
			timeStr = '';
		}
		document.getElementById('anim-position-readout').innerHTML = timeStr;

	}

	let modalsOpen;
	let playPreview; // 1 = high performance, 0 = low detail mode, undefined = undecided

	function setPlayPreview(event) {
		playPreview = parseInt(this.value);
		if (store !== undefined) {
			store.setItem('play-preview', playPreview);
		}
		document.getElementById('play-badge').hidden = playPreview === 0;
		const playModeModal = document.getElementById('play-mode-modal');
		if (playModeModal !== null && playModeModal.style.display !== 'block') {
			playModeModal.remove();
		}
	}

	for (let radio of document.getElementById('play-preview-row').querySelectorAll('input[name="play-preview"]')) {
		radio.addEventListener('input', setPlayPreview);
	}

	if (store !== undefined) {
		const value = parseInt(store.getItem('play-preview'));
		if (value >= 0) {
			playPreview = value;
			const radioContainer = document.getElementById('play-preview-row');
			checkInput(radioContainer, 'play-preview', playPreview);
			document.getElementById('play-badge').hidden = playPreview === 0;
		}
	}
	if (playPreview === undefined) {
		function setInitialPlayPreview(event) {
			setPlayPreview.apply(this, [event]);
			playPreview = parseInt(this.value);
			const radioContainer = document.getElementById('play-preview-row');
			checkInput(radioContainer, 'play-preview', playPreview);
			document.getElementById('play-badge').hidden = playPreview === 0;
			play();
		}

		document.getElementById('btn-play-fast').addEventListener('click', setInitialPlayPreview);
		document.getElementById('btn-play-detail').addEventListener('click', setInitialPlayPreview);

		$('#play-mode-modal').on('hidden.bs.modal', function (event) {
			this.remove();
		});
	}

	function animFinished() {
		for (let modal of modalsOpen) {
			modal.modal('show');
		}
		const playStopButton = document.getElementById('btn-play');
		playStopButton.children[0].src = 'img/control_play_blue.png';
		playStopButton.title = 'Play animation';
		const tween = animController.progress;
		animPositionSlider.value = tween;
		updateAnimPositionReadout(tween);
		syncAndDraw();
		animController = undefined;
	}

	function play() {
		if (playPreview === undefined) {
			$('#play-mode-modal').modal('show');
			return;
		}

		modalsOpen = [];
		const modalJQ = $(modal);
		if (modal.classList.contains('show')) {
			modalsOpen[0] = modalJQ;
			modalJQ.modal('hide');
		}
		const layersModal = document.getElementById('layers-modal');
		const layersModalJQ = $(layersModal);
		if (layersModal.classList.contains('show')) {
			modalsOpen.push(layersModalJQ);
			layersModalJQ.modal('hide');
		}

		const button = document.getElementById('btn-play');
		button.children[0].src = 'img/control_stop_blue.png';
		button.title = 'Stop animation';
		successAlert.alert('close');
		errorAlert.alert('close');
		document.getElementById('anim-position-readout').innerHTML = '';
		let start = 0;
		if (document.getElementById('anim-controls').classList.contains('show')) {
			start = parseFloat(animPositionSlider.value);
			if (start === 1) {
				start = 0;
			}
		}
		const length = parseFloat(document.getElementById('anim-length').value) * 1000;
		animController = animate(bgGenerator, drawingContext, canvas.width, canvas.height, start, length, loopAnim, playPreview);
		animController.promise = animController.promise.then(animFinished, animFinished);
		animController.start();
	}

	const noAnimErrorMsg = `
		<p>The start and end frames are the same so there is nothing to animate. Use the
		<span class="btn btn-sm btn-black"><img src="img/timeline_marker_start.png" alt="Start Frame" width="16" height="16"></span> and
		<span class="btn btn-sm btn-black"><img src="img/timeline_marker_end.png" alt="Start Frame" width="16" height="16"></span>
		buttons to set up animation frames.</p>
	`;

	document.getElementById('btn-play').addEventListener('click', function (event) {
		if (animController && animController.status === AnimationController.Status.RUNNING) {
			// Stop
			animController.abort();
			return;
		}

		document.getElementById('overlay').classList.remove('show');
		let unsavedChanges = !currentFrame.isCurrentFrame();
		let separateFrames = startFrame !== endFrame || ('tween' in bgGenerator);
		if (!separateFrames && unsavedChanges) {
			random = random.endGenerator;
			currentFrame = currentFrameData();
			endFrame = currentFrame;
			calcTweenData();
			separateFrames = true;
			unsavedChanges = false;
		}

		const lengthInput = document.getElementById('anim-length');
		const length = parseFloat(lengthInput.value);
		if (!(length > 0)) {
			showAlert(errorAlert, 'Invalid animation duration.', document.body);
			lengthInput.focus();
			return;
		}

		if (!separateFrames) {
			showAlert(errorAlert, noAnimErrorMsg, document.body);
		} else if (unsavedChanges) {
			animAction = play;
			$('#assign-bg-change-modal').modal('show');
		} else {
			play();
		}
	});


	$('#play-btn-group').on('show.bs.dropdown', function(event) {
		animControlsOpen = true;
	});

	 $('#play-btn-group').on('hide.bs.dropdown', function(event) {
		const target = document.activeElement;
		animControlsOpen = target.dataset.toggle !== 'dropdown' || !toolbar.contains(target);
		return !animControlsOpen;
	});

	 let seeking = false;

	animPositionSlider.addEventListener('input', function (event) {
		const tween = parseFloat(this.value);
		if (animController !== undefined) {
			animController.startTween = tween;
			animController.lastUIUpdate = tween;
			animController.beginTime = document.timeline.currentTime + 1;
			return;
		}

		if (!seeking) {
			let unsavedChanges = !currentFrame.isCurrentFrame();
			let separateFrames = startFrame !== endFrame || ('tween' in bgGenerator);
			if (!separateFrames && unsavedChanges) {
				random = random.endGenerator;
				currentFrame = currentFrameData();
				endFrame = currentFrame;
				calcTweenData();
				separateFrames = true;
				unsavedChanges = false;
			}
			if (!separateFrames) {
				showAlert(errorAlert, noAnimErrorMsg, document.body);
				this.value = 1;
				return;
			} else if (unsavedChanges) {
				animAction = renderAndSync;
				$('#assign-bg-change-modal').modal('show');
				return;
			}
			seeking = true;
		}
		renderFrame(bgGenerator, drawingContext, canvas.width, canvas.height, tween, loopAnim, false, 1, true);
		updateAnimPositionReadout(tween);
	});

	function syncToPosition() {
		const tween = parseFloat(animPositionSlider.value);
		const startRotation = startFrame.rotation;
		let endRotation = endFrame.rotation;
		const loopedRotation = loopAnim && (endRotation - startRotation) % TWO_PI !== 0;
		endRotation += (endRotation < startRotation ? -1 : 1) * TWO_PI * fullRotations;
		rotation = interpolateValue(startRotation, endRotation, tween, loopedRotation);
		rotationSlider.value = rotation / TWO_PI;
		seedInput.value = random.seed;
		currentFrame = currentFrameData();
	}

	function renderAndSync() {
		const tween = parseFloat(animPositionSlider.value);
		renderFrame(bgGenerator, drawingContext, canvas.width, canvas.height, tween, loopAnim, false, 0, false);
		updateAnimPositionReadout(tween);
		syncToPosition();
	}

	function syncAndDraw() {
		syncToPosition();
		seeking = false;
		progressiveBackgroundGen(0);
	}

	animPositionSlider.addEventListener('pointerup', syncAndDraw);
	animPositionSlider.addEventListener('keyup', syncAndDraw);

	document.getElementById('anim-length').addEventListener('input', function (event) {
		const length = parseFloat(this.value);
		if (length > 0) {
			updateAnimPositionReadout(animPositionSlider.value);
			videoErrorAlert.alert('close');
		}
	});

	document.getElementById('btn-rewind').addEventListener('click', function (event) {
		if (startFrame === endFrame) {
			if ('tween' in bgGenerator) {
				random = random.endGenerator;
				currentFrame = currentFrameData();
				endFrame = currentFrame;
				calcTweenData();
			} else {
				return;
			}
		}
		animPositionSlider.value = 0;
		renderAndSync();
	});

	document.getElementById('btn-anim-opts').addEventListener('click', function (event) {
		$('#anim-opts-modal').modal('show');
	});

	document.getElementById('background-rotations').addEventListener('input', function (event) {
		const value = parseFloat(this.value);
		if (Number.isFinite(value)) {
			fullRotations = value;
		}
	});

	document.getElementById('anim-loop').addEventListener('input', function (event) {
		loopAnim = this.checked;
		const currentPosition = parseFloat(animPositionSlider.value);
		let newPosition;
		if (loopAnim) {
			newPosition = currentPosition / 2;
		} else if (currentPosition <= 0.5) {
			newPosition = currentPosition * 2;
		} else {
			newPosition = (1 - currentPosition) * 2;
		}
		animPositionSlider.value = newPosition;
		updateAnimPositionReadout(newPosition);
	});

	{
		const currentResStr = screen.width + 'x' + screen.height;
		let currentResOption = videoResolutionInput.querySelector('option[value="' + currentResStr +'"]');
		if (currentResOption === null) {
			currentResOption = document.createElement('OPTION');
			currentResOption.value = currentResStr;
			videoResolutionInput.appendChild(currentResOption);
		}
		currentResOption.innerHTML = 'Full Screen (' + screen.height + 'p)';
		currentResOption.selected = true;
	}

	const imageFormats = new Set();
	imageFormats.add('png');

	function checkImageFormats() {
		if (imageFormats.size > 1) {
			return;
		}

		const testCanvas = document.createElement('CANVAS');
		testCanvas.width = 1;
		testCanvas.height = 1;
		for (let format of ['jpeg', 'webp']) {
			const mime = 'image/' + format;
			const url = testCanvas.toDataURL(mime);
			if (url.startsWith('data:' + mime)) {
				imageFormats.add(format);
			}
		}

		const videoFormatInput = document.getElementById('video-format');
		const picFormatInput = document.getElementById('pic-format');
		let formatDeleted = false;

		if (!imageFormats.has('jpeg')) {
			videoFormatInput.querySelector('option[value="jpg"]').remove();
			picFormatInput.querySelector('option[value="jpg"]').remove();
			formatDeleted = true;
		}
		if (!imageFormats.has('webp')) {
			videoFormatInput.querySelector('option[value="webm"]').remove();
			videoFormatInput.querySelector('option[value="webp"]').remove();
			picFormatInput.querySelector('option[value="webp"]').remove();
			formatDeleted = true;

			if (imageFormats.has('jpeg')) {
				const option = document.createElement('OPTION');
				option.value = 'mjpg';
				option.innerHTML = 'MJPEG-AVI Video';
				videoFormatInput.prepend(option);
				videoFormatInput.value = 'mjpg';
			}
		}
		if (formatDeleted) {
			setVideoFormat();
		}
	}

	document.getElementById('btn-video-opts').addEventListener('click', function (event) {
		if (document.getElementById('btn-render-video').disabled) {
			// Video rendering already in progress.
			$('#video-modal').modal('show');
			return;
		}
		checkImageFormats();
		if (imageFormats.has('webp')) {
			requireScript('lib/CCapture.webm.min.js');
		} else {
			requireScript('lib/CCapture.mjpg.min.js');
		}

		let unsavedChanges = !currentFrame.isCurrentFrame();
		const separateFrames = startFrame !== endFrame || ('tween' in bgGenerator);
		if (!separateFrames && unsavedChanges) {
			random = random.endGenerator;
			currentFrame = currentFrameData();
			endFrame = currentFrame;
			calcTweenData();
			unsavedChanges = false;
		}
		if (unsavedChanges) {
			animAction = function () {
				$('#video-modal').modal('show');
			};
			$('#assign-bg-change-modal').modal('show')
		} else {
			$('#video-modal').modal({backdrop: 'static', keyboard: false});
		}
	});

	function setVideoFormat() {
		const format = document.getElementById('video-format').value;
		const qualitySlider = document.getElementById('video-quality');
		const lossy = format !== 'png';
		qualitySlider.disabled = !lossy;
		videoQualityReadout.innerHTML = lossy ? qualitySlider.value + '%' : 'N/A';

		if (format !== 'webm' && format !== 'mjpg') {
			requireScript('lib/tar.min.js');
		}
	}

	document.getElementById('video-format').addEventListener('input', setVideoFormat);

	{
		const notifyVideoInput = document.getElementById('notify-video-render');
		const notifyPicInput = document.getElementById('notify-pic-render');
		if (window.Notification) {
			if (store !== undefined) {
				notifyVideoInput.checked =
					Notification.permission === 'granted' &&
					store.getItem('notify-render') === 'true';
				notifyPicInput.checked = notifyVideoInput.checked;
			}

			function changeNotificationPref(event) {
				document.getElementById('notify-video-render').checked = this.checked;
				document.getElementById('notify-pic-render').checked = this.checked;

				if (Notification.permission === 'granted') {

					if (store !== undefined) {
						store.setItem('notify-render', this.checked);
					}

				} else if (this.checked) {

					Notification.requestPermission().then(function (permission) {
						if (permission === 'denied') {
							document.getElementById('notify-video-render').checked = false;
							document.getElementById('notify-pic-render').checked = false;

						} else if (permission === 'granted' && store !== undefined) {
							store.setItem('notify-render', document.getElementById('notify-video-render').checked);
						}
					});
				}
			};
			notifyVideoInput.addEventListener('input', changeNotificationPref);
			notifyPicInput.addEventListener('input', changeNotificationPref);
		} else {
			notifyVideoInput.hidden = true;
			notifyPicInput.hidden = true;
		}
	}

	document.getElementById('btn-render-video').addEventListener('click', async function (event) {
		let errorMsg = '';
		if (startFrame === endFrame && !('tween' in bgGenerator)) {
			errorMsg = noAnimErrorMsg;
		}
		let length = parseFloat(document.getElementById('anim-length').value);
		if (!(length > 0)) {
			errorMsg += '<p>Invalid video duration.</p>'
		}
		const framerate = parseInt(document.getElementById('video-framerate').value);
		if (!(framerate > 0)) {
			errorMsg += '<p>Invalid frame rate.</p>'
		}
		const motionBlur = parseInt(document.getElementById('motion-blur').value) + 1;
		if (!(motionBlur >= 1)) {
			errorMsg += '<p>Invalid number of motion blur frames.</p>';
		}

		if (errorMsg === '') {

			videoErrorAlert.alert('close');
			const properties = {
				framerate: framerate,
				motionBlurFrames: motionBlur,
				format: document.getElementById('video-format').value,
				quality: parseInt(document.getElementById('video-quality').value),
				name: generateFilename(),
				workersPath: 'lib/',
			};

			const resolutionStr = videoResolutionInput.value;
			const videoWidth = parseInt(resolutionStr);
			const videoHeight = parseInt(resolutionStr.slice(resolutionStr.indexOf('x') + 1));
			const captureCanvas = document.createElement('CANVAS');
			captureCanvas.width = videoWidth;
			captureCanvas.height = videoHeight;
			if (debug.video) {
				canvas.hidden = true;
				document.body.appendChild(captureCanvas);
			}
			const scale = videoHeight / window.innerHeight;
			const drawWidth = videoWidth / scale;
			const drawHeight = window.innerHeight;
			const contextualInfo = new DrawingContext(captureCanvas, videoWidth, videoHeight, scale);
			contextualInfo.initializeShader(bgGenerator);
			contextualInfo.copyTypes(drawingContext);
			captureVideo(contextualInfo, drawWidth, drawHeight, length * 1000, properties);

		} else {

			const element = videoErrorAlert.get(0);
			element.innerHTML = errorMsg;
			element.hidden = false;
			element.classList.add('show');
			document.getElementById('video-modal-body').appendChild(element);

		}
	});

	const videoQualityReadout = document.getElementById('video-quality-readout');

	document.getElementById('video-quality').addEventListener('input', function (event) {
		videoQualityReadout.innerHTML = this.value + '%';
	});

	document.getElementById('btn-cancel-video-render').addEventListener('click', function (event) {
		if (animController === undefined) {
			$('#video-modal').modal('hide');
		} else {
			animController.abort();
		}
	});

	const pictureWidths = new Map();
	pictureWidths.set('px', [1920, 1366, 1280, 1024, 640]);
	pictureWidths.set('in', [5, 6, 7, 8, 10, 12, 16, 18, 20, 24, 30, 36, 40, 60]);
	pictureWidths.set('mm', [85, 148, 210, 297, 420, 594, 841, 1189]);

	const pictureHeights = new Map();
	pictureHeights.set('px', [1080, 768, 720, 480, 360]);
	pictureHeights.set('in', [4, 5, 6, 8, 12, 16, 18, 20, 24, 30, 36, 40]);
	pictureHeights.set('mm', [55, 105, 148, 210, 297, 420, 594, 841]);

	const paperSizeNames = new Map();
	paperSizeNames.set('85x55', 'Business Card');
	paperSizeNames.set('148x105', 'A6 (Postcard)');
	paperSizeNames.set('210x148', 'A5');
	paperSizeNames.set('297x210', 'A4');
	paperSizeNames.set('420x297', 'A3');
	paperSizeNames.set('594x420', 'A2');
	paperSizeNames.set('841x594', 'A1');
	paperSizeNames.set('1189x841', 'A0');

	document.getElementById('btn-render-pic').addEventListener('click', function (event) {
		const downloadModal = document.getElementById('save-pic-modal');
		const background = queryChecked(downloadModal, 'paper-type');
		let saveCanvas;
		if (background.value === 'transparent') {
			saveCanvas = canvas;
		} else {
			saveCanvas = document.createElement('CANVAS');
			saveCanvas.width = canvas.width;
			saveCanvas.height = canvas.height;
			const saveContext = saveCanvas.getContext('2d');
			saveContext.fillStyle = backgroundElement.style.backgroundColor;
			saveContext.fillRect(0, 0, canvas.width, canvas.height);
			saveContext.drawImage(canvas, 0, 0);
		}

		this.download = generateFilename() + '.png';
		this.href = saveCanvas.toDataURL();
		$(downloadModal).modal('hide');
	});

	$('#save-dropdown').on('shown.bs.dropdown', function (event) {
		document.getElementById('save-result').innerHTML = '';
		const titleInput = document.getElementById('work-title');
		if (titleInput.value.trim() === '') {
			titleInput.focus();
		} else {
			document.getElementById('work-keywords').focus();
		}
	});

	document.getElementById('save-form').addEventListener('submit', async function (event) {
		event.preventDefault();
		const data = {};
		// TODO Add user authentication
		data.user = '1';
		data.documentID = urlParameters.get('doc');
		data.title = document.getElementById('work-title').value.trim();
		const keywords = [];
		for (let keyword of document.getElementById('work-keywords').value.split(',')) {
			keyword = keyword.trim();
			if (keyword !== '' && !keywords.includes(keyword)) {
				keywords.push(keyword);
			}
		}
		data.category = currentSketch.title;
		data.keywords = keywords;
		const doc = {};
		data.document = doc;
		data.attachments = [];

		doc.sketch = currentSketch.url;
		doc.startFrame = startFrame.toObject();
		if (startFrame !== endFrame) {
			doc.endFrame = endFrame.toObject();
		}

		const options = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(data),
		};
		let success;
		let constraint;
		try {
			const response = await fetch(backendRoot + 'save', options);
			const responseData = await response.json();
			success = responseData.success;
			constraint = responseData.constraint;
			if (success || constraint === 'unique_document') {
				urlParameters.set('doc', responseData.documentID);
				urlParameters.delete('gen');
				updateURL();
			}
		} catch (e) {
			console.error(e);
			success = false;
		}
		const resultBox = document.getElementById('save-result');
		if (success) {
			resultBox.innerHTML = 'Saved.';
			setTimeout(function () {
				resultBox.innerHTML = '';
			}, 10000);
		} else {
			switch (constraint) {
			case 'unique_document':
				resultBox.innerHTML = 'This artwork has been created before.';
				break;
			case 'unique_title':
				resultBox.innerHTML = 'You already have an artwork called <i>' + data.title + '</i>.';
				break;
			default:
				resultBox.innerHTML = 'Sorry, an error occurred.';
			}
		}
	});

	imageUpload.querySelector('#background-gen-image-upload').addEventListener('input', function (event) {
		const file = this.files[0];
		if (file) {
			if (bgGeneratorImage.src) {
				URL.revokeObjectURL(bgGeneratorImage.src);
			}
			bgGeneratorImage.src = URL.createObjectURL(file);
			// The onload event will redraw the image.
		}
	});

	clearComboboxesOnFocus();

	$(document.getElementById('anim-controls').parentElement).on('shown.bs.dropdown', 	function (event) {
		const menu = this.querySelector('.dropdown-menu-abs-right');
		setTimeout(function () {
			const height = Math.ceil(menu.clientHeight);
			menu.style.transform = 'translate(1px, -' + height + 'px)';
		}, 0);
	});

	$('.modal').on('show.bs.modal', function (event) {
		document.getElementById('overlay').classList.remove('show');
	});

}
