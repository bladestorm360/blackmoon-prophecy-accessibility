// The tests and save-index tool share the same default for this development machine.
// BMA_GAME_DIR can point to another folder containing Game.exe and www.
module.exports = process.env.BMA_GAME_DIR ||
  'C:\\Games\\Blackmoon Prophecy Remake 1.05S\\Final Fantasy Blackmoon Prophecy Remake';
