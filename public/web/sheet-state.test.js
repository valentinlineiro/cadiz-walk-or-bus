import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionSheet } from './sheet-state.js';

test('sheet-state: IDLE transitions', () => {
  assert.equal(transitionSheet('IDLE', 'OPEN_SEARCH'), 'SEARCH');
  assert.equal(transitionSheet('IDLE', 'SELECT_DEST'), 'VERDICT');
  assert.equal(transitionSheet('IDLE', 'UNKNOWN_EVENT'), 'IDLE');
  assert.equal(transitionSheet('IDLE', 'CANCEL'), 'IDLE');
});

test('sheet-state: SEARCH transitions', () => {
  assert.equal(transitionSheet('SEARCH', 'SELECT_DEST'), 'VERDICT');
  // Without active destination, cancel/close returns to IDLE
  assert.equal(transitionSheet('SEARCH', 'CANCEL', { hasDestination: false }), 'IDLE');
  assert.equal(transitionSheet('SEARCH', 'CLOSE', { hasDestination: false }), 'IDLE');
  // With active destination, cancel/close returns to VERDICT
  assert.equal(transitionSheet('SEARCH', 'CANCEL', { hasDestination: true }), 'VERDICT');
  assert.equal(transitionSheet('SEARCH', 'CLOSE', { hasDestination: true }), 'VERDICT');
  assert.equal(transitionSheet('SEARCH', 'UNKNOWN_EVENT'), 'SEARCH');
});

test('sheet-state: VERDICT transitions', () => {
  assert.equal(transitionSheet('VERDICT', 'CHANGE_DEST'), 'SEARCH');
  assert.equal(transitionSheet('VERDICT', 'OPEN_SEARCH'), 'SEARCH');
  assert.equal(transitionSheet('VERDICT', 'RESET'), 'IDLE');
  assert.equal(transitionSheet('VERDICT', 'UNKNOWN_EVENT'), 'VERDICT');
});

test('sheet-state: full user flows (IDLE -> SEARCH -> VERDICT -> SEARCH -> VERDICT -> IDLE)', () => {
  let state = 'IDLE';

  // 1. User taps search trigger from IDLE
  state = transitionSheet(state, 'OPEN_SEARCH');
  assert.equal(state, 'SEARCH');

  // 2. User selects destination
  state = transitionSheet(state, 'SELECT_DEST');
  assert.equal(state, 'VERDICT');

  // 3. User taps "Cambiar destino"
  state = transitionSheet(state, 'CHANGE_DEST');
  assert.equal(state, 'SEARCH');

  // 4. User cancels without changing destination -> returns to active VERDICT
  state = transitionSheet(state, 'CANCEL', { hasDestination: true });
  assert.equal(state, 'VERDICT');

  // 5. User changes destination again and selects new one
  state = transitionSheet(state, 'CHANGE_DEST');
  assert.equal(state, 'SEARCH');
  state = transitionSheet(state, 'SELECT_DEST');
  assert.equal(state, 'VERDICT');

  // 6. Reset/clear route -> returns to IDLE
  state = transitionSheet(state, 'RESET');
  assert.equal(state, 'IDLE');

  // 7. Search canceled when no destination active -> returns to IDLE
  state = transitionSheet(state, 'OPEN_SEARCH');
  assert.equal(state, 'SEARCH');
  state = transitionSheet(state, 'CANCEL', { hasDestination: false });
  assert.equal(state, 'IDLE');
});
