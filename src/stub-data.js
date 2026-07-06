'use strict';

// Generates plausible stub sensor data when a recording is stopped.
// Replace with real sensor integration later.
function generateData(exerciseId, startedAt, endedAt) {
  const n = 200;
  const rand = (min, max) => min + Math.random() * (max - min);

  const mouth = Array.from({ length: n }, () => [
    +rand(0.0, 0.3).toFixed(4),
    +rand(0.0, 0.5).toFixed(4),
  ]);
  const sound = Array.from({ length: n }, () => +rand(40, 85).toFixed(2)); // dB
  const speed = Array.from({ length: n }, () => +rand(0, 180).toFixed(2)); // cm/s
  const steps = Array.from({ length: 15 }, () => +rand(30, 80).toFixed(1)); // cm

  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  return {
    exerciseId,
    startedAt,
    endedAt,
    mouthOpening: { values: mouth, sampleRate: 30 },
    soundPressure: { values: sound, sampleRate: 48000, unit: 'dB' },
    footSpeed: { values: speed, sampleRate: 100, unit: 'cm/s' },
    aggregates: {
      stepLengths: { values: steps, unit: 'cm' },
      averages: {
        mouthOpeningVertical: +avg(mouth.map((t) => t[0])).toFixed(4),
        mouthOpeningHorizontal: +avg(mouth.map((t) => t[1])).toFixed(4),
        soundPressure: +avg(sound).toFixed(2),
        footSpeed: +avg(speed).toFixed(2),
        stepLength: +avg(steps).toFixed(2),
      },
      medians: {
        mouthOpeningVertical: +median(mouth.map((t) => t[0])).toFixed(4),
        mouthOpeningHorizontal: +median(mouth.map((t) => t[1])).toFixed(4),
        soundPressure: +median(sound).toFixed(2),
        footSpeed: +median(speed).toFixed(2),
        stepLength: +median(steps).toFixed(2),
      },
    },
  };
}

module.exports = { generateData };
