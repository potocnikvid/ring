let fft;
let audio;
let easycam;
let spectrumHistory = [];
function preload() {
  audio = loadSound("assets/tobogan.mp3");
}

function setup() {
  createCanvas(window.innerWidth, window.innerHeight, WEBGL);
  easycam = createEasyCam();
  fft = new p5.FFT();
  audio.loop();
}

// function draw() {
//   background(0);

//   // Analyze the sound
//   let spectrum = fft.analyze();

//   translate(0, 0, -width / 2);
//   // Draw the visualizer
//   for (let i = 0; i < spectrum.length; i+=16) {
//     let amp = spectrum[i];
//     let y = map(amp, 0, 256, 0, height);
//     let x = map(i, 0, spectrum.length, -width / 2, width / 2);

//     push();
//     translate(x, height / 2 - y / 2, 0);
//     fill(255 - amp, amp, i % 255);
//     box(12, y, 10);
//     pop();
//   }
// }
function draw() {
  background(0);

  // Analyze the sound
  let spectrum = fft.analyze();
  spectrumHistory.push(spectrum); // Add current spectrum to history

  translate(-width / 2, -height / 2, -width); // Offset the view

  // Go through spectrum history
  for (let i = 0; i < spectrumHistory.length; i+=1
    ) {
    let historySpectrum = spectrumHistory[i];
    for (let j = 0; j < historySpectrum.length; j += 16) {
      let amp = historySpectrum[j];
      let y = map(amp, 0, 256, 0, height/2);
      let z = map(i, 0, spectrumHistory.length, -width / 2, width / 2);
      let x = map(j, 0, historySpectrum.length, 0, width);

      push();
      translate(x, height - y, z);
      fill(255 - amp, amp, j % 255);
      box(10, y, 10);
      pop();
    }
  }

  if (spectrumHistory.length > width / 24) {
    // Adjust size accordingly
    spectrumHistory.splice(0, 1); // Remove oldest spectrum if history is too long
  }
}

function windowResized() {
  resizeCanvas(window.innerWidth, window.innerHeight);
  easycam.setViewport([0, 0, window.innerWidth, window.innerHeight]);
}

function keyPressed() {
    if (keyCode === LEFT_ARROW) {
      audio.jump(audio.currentTime() - 5);
    } else if (keyCode === RIGHT_ARROW) {
      audio.jump(audio.currentTime() + 5);
    } else if (keyCode === UP_ARROW) {
      audio.setVolume(audio.getVolume() + 0.5);
    } else if (keyCode === DOWN_ARROW) {
      audio.setVolume(audio.getVolume() - 0.5);
    } else if (keyCode === ENTER) {
      if (audio.isPlaying()) {
        audio.pause();
        noLoop();
      } else {
        audio.play();
        loop();
      }
    }
  }