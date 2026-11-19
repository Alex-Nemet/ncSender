import assert from 'node:assert/strict';
import {test} from 'node:test';
import GCodeVisualizer from '../src/features/toolpath/visualizer/gcode-visualizer.js';

const program = 'G20 G90\nG0 Z1\nG0 X1 Y1\nG1 Z-0.1 F50\nG28 G91 Z0\nG90\nG0 X0 Y0\nM30';
const bounds = (maxZ) => ({minX: -100, maxX: 1000, minY: -100, maxY: 1000, minZ: -150, maxZ});

test('G28 lift follows the machine top when Z zero moves up', () => {
  const v = new GCodeVisualizer();
  v.setGridBounds(bounds(125));
  v.render(program);
  assert.equal(v.hasOutOfBoundsMovement(), false);
  v.setGridBounds(bounds(124.746)); // Z zero raised 0.01 in
  assert.equal(v.hasOutOfBoundsMovement(), false);
  const zs = Array.from(v.pathLines[0].geometry.attributes.position.array).filter((_, i) => i % 3 === 2);
  const near = (z) => zs.some((v) => Math.abs(v - z) < 1e-3);
  assert.ok(near(124.746));
  assert.ok(!near(125));
});

test('real moves above the machine top are still flagged', () => {
  const v = new GCodeVisualizer();
  v.setGridBounds(bounds(20));
  v.render('G21 G90\nG0 Z10\nG0 Z30\nG28 G91 Z0');
  assert.equal(v.hasOutOfBoundsMovement(), true);
  v.setGridBounds(bounds(19));
  assert.equal(v.hasOutOfBoundsMovement(), true);
  assert.deepEqual(v.getOutOfBoundsDirections(), ['Z+']);
});

test('G28 lift keeps following through several Z zero changes with uneven heights', () => {
  const v = new GCodeVisualizer();
  v.setGridBounds(bounds(69.1237));
  v.render(program);
  for (const top of [51.3437, 51.0897, 60.7771, 33.3333]) {
    v.setGridBounds(bounds(top));
    assert.equal(v.hasOutOfBoundsMovement(), false, 'flagged at top ' + top);
  }
});
