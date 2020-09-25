const MAX_ATTRACTORS = 50;

export default function Contours() {
	const me = this;
	this.title = 'Contours';
	this.isShader = true;
	this.helpFile = 'help/contours.html';
	this.backgroundColor = [0, 0, 0];

	this.numAttractors = Math.min(Math.round((window.innerWidth * window.innerHeight) / (800 * 600) * 10), MAX_ATTRACTORS);

	this.optionsDocument = downloadFile('contours.html', 'document').then(function (optionsDoc) {
		function fullRedraw() {
			generateBackground(0);
		}

		function setNumericProperty(name) {
			return function(event) {
				const value = parseFloat(this.value);
				if (Number.isFinite(value) && value !== me[name]) {
					setBgProperty(me, name, value);
					generateBackground(0);
				}
			}
		}

		function setNumericPropertyElement(name, index) {
			return function(event) {
				const value = parseFloat(this.value);
				if (Number.isFinite(value) && value !== me[name][index]) {
					setBgPropertyElement(me, name, index, value);
					generateBackground(0);
				}
			}
		}

		function setSliderProperty(name) {
			return function(event) {
				const value = parseFloat(this.value);
				setBgProperty(me, name, value);
				generateBackground(1);
			}
		}

		optionsDoc.getElementById('force-field-constant').addEventListener('input', setNumericProperty('fieldConstant'));
		optionsDoc.getElementById('force-divisor').addEventListener('input', setNumericProperty('divisor'));
		optionsDoc.getElementById('force-base').addEventListener('input', setNumericProperty('base'));
		optionsDoc.getElementById('force-field-exponent').addEventListener('input', setNumericProperty('fieldExponent'));
		optionsDoc.getElementById('force-minkowski-order').addEventListener('input', setNumericProperty('minkowskiOrder'));

		optionsDoc.getElementById('force-minkowski-finite').addEventListener('input', function (event) {
			const numberInput = document.getElementById('force-minkowski-order');
			numberInput.disabled = false;
			const value = parseFloat(numberInput.value);
			if (Number.isFinite(value)) {
				setBgProperty(me, 'minkowskiOrder', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-minkowski-infinite').addEventListener('input', function (event) {
			document.getElementById('force-minkowski-order').disabled = true;
			setBgProperty(me, 'minkowskiOrder', 13);
			generateBackground(0);
		});

		optionsDoc.getElementById('force-distance-weight').addEventListener('input', setNumericProperty('distanceWeight'));

		optionsDoc.getElementById('force-sine-power').addEventListener('input', setNumericProperty('sinePower'));

		optionsDoc.getElementById('force-hue-frequency').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0) {
				setBgProperty(me, 'hueFrequency', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-wave-hue').addEventListener('input', setNumericProperty('waveHue'));

		const hueRotationTurnsInput = optionsDoc.getElementById('force-hue-rotation-turns');
		const hueRotationFracInput = optionsDoc.getElementById('force-hue-rotation-fraction');

		function setHueRotation() {
			let turns = parseInt(hueRotationTurnsInput.value);
			if (!Number.isFinite(turns)) {
				turns = Math.trunc(me.hueRotation);
			}
			const value = turns + parseFloat(hueRotationFracInput.value);
			setBgProperty(me, 'hueRotation', value);
			const preview = event.target === hueRotationFracInput ? 1 : 0;
			generateBackground(preview);
		}

		hueRotationTurnsInput.addEventListener('input', setHueRotation);
		hueRotationFracInput.addEventListener('input', setHueRotation);
		hueRotationFracInput.addEventListener('pointerup', fullRedraw);
		hueRotationFracInput.addEventListener('keyup', fullRedraw);

		optionsDoc.getElementById('force-color-portion').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0) {
				setBgProperty(me, 'colorPortion', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-sharpness').addEventListener('input', function (event) {
			let value = parseFloat(this.value);
			if (value >= 0 && value <= 1) {
				if (value === 1) {
					value = 0.99;
				}
				setBgProperty(me, 'sharpness', value);
				generateBackground(0);
			}
		});

		const minLightnessInput = optionsDoc.getElementById('force-min-lightness');
		const maxLightnessInput = optionsDoc.getElementById('force-max-lightness');

		minLightnessInput.addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0 && value <= 1) {
				setBgProperty(me, 'minLightness', value);
				if (value > me.maxLightness) {
					maxLightnessInput.value = value;
					setBgProperty(me, 'maxLightness', value);
				}
				generateBackground(0);
			}
		});

		maxLightnessInput.addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0 && value <= 1) {
				setBgProperty(me, 'maxLightness', value);
				if (value < me.minLightness) {
					minLightnessInput.value = value;
					setBgProperty(me, 'minLightness', value);
				}
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-wave-lightness').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value <= 1) {
				setBgProperty(me, 'waveLightness', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-contrast').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0 && value <= 1) {
				setBgProperty(me, 'contrast', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-foreground-saturation').addEventListener('input', setNumericProperty('foregroundSaturation'));

		const bgSaturationInput = optionsDoc.getElementById('force-background-saturation');
		const flipHueCheckbox = optionsDoc.getElementById('force-flip-hue');

		bgSaturationInput.addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0 && value <= 1) {
				const flipped = flipHueCheckbox.checked ? -1 : 1;
				setBgProperty(me, 'backgroundSaturation', flipped * value);
				generateBackground(0)
			}
		});

		flipHueCheckbox.addEventListener('input', function (event) {
			const value = me.backgroundSaturation * -1;
			setBgProperty(me, 'backgroundSaturation', value);
			generateBackground(0);
		});

		const coloringInput = optionsDoc.getElementById('force-base-intensity');
		coloringInput.addEventListener('input', setSliderProperty('baseIntensity'));
		coloringInput.addEventListener('pointerup', fullRedraw);
		coloringInput.addEventListener('keyup', fullRedraw);

		const opacityInput = optionsDoc.getElementById('force-background-opacity');
		opacityInput.addEventListener('input', setSliderProperty('backgroundOpacity'));
		opacityInput.addEventListener('pointerup', fullRedraw);
		opacityInput.addEventListener('keyup', fullRedraw);

		const baseColorInput = optionsDoc.getElementById('force-base-color');
		baseColorInput.addEventListener('input', setSliderProperty('baseColor'));
		baseColorInput.addEventListener('pointerup', fullRedraw);
		baseColorInput.addEventListener('keyup', fullRedraw);

		optionsDoc.getElementById('force-sine-frequency').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0) {
				setBgProperty(me, 'sineFrequency', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-base-scale').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0) {
				setBgProperty(me, 'baseScale', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-base-saturation').addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0 && value <= 1) {
				setBgProperty(me, 'baseSaturation', value);
				generateBackground(0);
			}
		});

		Array.from(optionsDoc.querySelectorAll('input[name="force-brightness"]')).forEach(function (element, index) {
			element.addEventListener('input', setNumericPropertyElement('baseBrightness', index));
		});

		const numAttractorsInput = optionsDoc.getElementById('force-num-attractors');
		numAttractorsInput.value = me.numAttractors;
		numAttractorsInput.addEventListener('input', function (event) {
			const value = parseFloat(this.value);
			if (value >= 0 && value <= MAX_ATTRACTORS) {
				setBgProperty(me, 'numAttractors', value);
				generateBackground(0);
			}
		});

		optionsDoc.getElementById('force-explosion').addEventListener('input', setNumericProperty('explosion'));

		return optionsDoc;
	});

	this.positionX = new Array(MAX_ATTRACTORS);
	this.positionY = new Array(MAX_ATTRACTORS);
	this.strength = new Array(MAX_ATTRACTORS);
	this.saturations = new Array(MAX_ATTRACTORS);
	this.xDist = [1, 1, 1, 1, 1];
	this.yDist = [1, 1, 1];
	this.strengthDist = [1, 1, 1, 1, 1];
	this.saturationDist = [0, 0, 0, 0, 1];
	this.explosion = 1;

	this.fieldConstant = 100;
	this.fieldExponent = 2;
	this.divisor = 100;
	this.base = 2.8;
	this.sineFrequency = 1;
	this.sinePower = 1;	// Multiplied by 2 in WebGL

	this.minkowskiOrder = 2;
	this.distanceWeight = 0; // Canberra distance

	this.hueFrequency = 0;
	this.hueRotation = 0;
	this.waveHue = 0;

	this.foregroundSaturation = 1;
	this.backgroundSaturation = 1;

	this.maxLightness = 0.4;
	this.minLightness = 0;
	this.waveLightness = 1;
	this.contrast = 0;

	this.colorPortion = 0.5;
	this.sharpness = 0;

	this.baseColor = 0;
	this.baseIntensity = 0;
	this.baseScale = 20;
	this.backgroundOpacity = 0;
	this.baseBrightness = [1, 1, 1, 1];
	this.baseSaturation = 1;

	this.minDotSize = 5;
	this.maxDotSize = this.minDotSize;
	this.dotColor = [1/6, 1, 0.5, 1];	// HSLA

	this.randomize();
}

Contours.prototype.randomize = function () {
	const positionX = this.positionX;
	const positionY = this.positionY;
	const strength = this.strength;
	const saturations = this.saturations;

	const NUM_COLUMNS = 5;
	const NUM_ROWS = 3;
	const NUM_STRENGTHS = 5;
	const NUM_SATURATIONS = 5;

	const xDist = new Array(NUM_COLUMNS);
	const yDist = new Array(NUM_ROWS);
	const strengthDist = new Array(NUM_STRENGTHS);
	const saturationDist = new Array(NUM_SATURATIONS);
	let xDistTotal = 0, yDistTotal = 0, strengthDistTotal = 0, saturationDistTotal = 0;

	for (let i = 0; i < NUM_COLUMNS; i++) {
		xDistTotal += this.xDist[i];
		xDist[i] = xDistTotal;
	}
	for (let i = 0; i < NUM_ROWS; i++) {
		yDistTotal += this.yDist[i];
		yDist[i] = yDistTotal;
	}
	for (let i = 0; i < NUM_STRENGTHS; i++) {
		strengthDistTotal += this.strengthDist[i];
		strengthDist[i] = strengthDistTotal;
	}
	for (let i = 0; i < NUM_SATURATIONS; i++) {
		saturationDistTotal += this.saturationDist[i];
		saturationDist[i] = saturationDistTotal;
	}

	const grid = new Array(NUM_COLUMNS);
	for (let i = 0; i < NUM_COLUMNS; i++) {
		const arr = new Array(NUM_ROWS);
		grid[i] = arr;
		for (let j = 0; j < NUM_ROWS; j++) {
			arr[j] = [];
		}
	}

	for (let i = 0; i < MAX_ATTRACTORS; i++) {
		let p = random.next() * xDistTotal;
		let column = NUM_COLUMNS - 1;
		while (column > 0 && xDist[column - 1] >= p) {
			column--;
		}
		p = random.next() * yDistTotal;
		let row = NUM_ROWS - 1;
		while (row > 0 && yDist[row - 1] >= p) {
			row--;
		}
		const x = (column + random.next()) / NUM_COLUMNS;
		const y = (row + random.next()) / NUM_ROWS;
		grid[column][row].push(x, y);

		p = random.next() * strengthDistTotal;
		let bin = NUM_STRENGTHS - 1;
		while (bin > 0 && strengthDist[bin - 1] >= p) {
			bin--;
		}
		strength[i] = (bin + random.next()) / NUM_STRENGTHS;

		p = random.next() * saturationDistTotal;
		bin = NUM_SATURATIONS - 1;
		while (bin > 0 && saturationDist[bin - 1] >= p) {
			bin--;
		}
		saturations[i] = (bin + random.next()) / NUM_SATURATIONS;
	}

	let n = 0;
	for (let i = 0; i < NUM_COLUMNS; i++) {
		for (let j = 0; j < NUM_ROWS; j++) {
			const jPrime = i % 2 === 0 ? j : NUM_ROWS - 1 - j;
			const cell = grid[i][jPrime];
			for (let k = 0; k < cell.length; k += 2) {
				positionX[n] = cell[k];
				positionY[n] = cell[k + 1];
				n++;
			}
		}
	}
}

Contours.prototype.animatable = {
	continuous: [
		'positionX', 'positionY', 'strength', 'fieldConstant', 'fieldExponent',
		'sinePower', 'sineFrequency',
		'divisor', 'base', 'saturations', 'foregroundSaturation', 'backgroundSaturation',
		'contrast', 'baseColor', 'baseIntensity', 'baseScale', 'baseBrightness', 'baseSaturation',
		'minkowskiOrder', 'distanceWeight',
		'hueFrequency', 'hueRotation', 'waveHue',
		'waveLightness', 'minLightness', 'maxLightness', 'backgroundOpacity',
		'colorPortion', 'sharpness', 'numAttractors', 'explosion',
		'minDotSize', 'maxDotSize', 'dotColor',
	],
}
