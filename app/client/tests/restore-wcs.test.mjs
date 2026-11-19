import assert from 'node:assert/strict';
import {test} from 'node:test';
import {lastWcsInProgram} from '../../electron/features/gcode/job-manager.js';

test('finds the last WCS a program selects, ignoring comments and G59.1', () => {
  assert.equal(lastWcsInProgram('G90 G54\nG0 X1\nG55\nM30'), 'G55');
  assert.equal(lastWcsInProgram('G56 G0 X0\n(back to G54)\nG0 X1 ; G57\nG59.1\nM30'), 'G56');
  assert.equal(lastWcsInProgram('g55 g0 x1'), 'G55');
  assert.equal(lastWcsInProgram('G0 X1\nM30'), null);
});
