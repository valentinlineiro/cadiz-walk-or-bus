export const SHEET_STATES = Object.freeze({
  IDLE: 'IDLE',
  SEARCH: 'SEARCH',
  VERDICT: 'VERDICT',
});

/**
 * Pure transition function for the bottom sheet interaction state machine.
 *
 * @param {'IDLE' | 'SEARCH' | 'VERDICT'} currentState
 * @param {'OPEN_SEARCH' | 'SELECT_DEST' | 'CANCEL' | 'CLOSE' | 'CHANGE_DEST' | 'RESET'} event
 * @param {{ hasDestination?: boolean }} [context]
 * @returns {'IDLE' | 'SEARCH' | 'VERDICT'}
 */
export function transitionSheet(currentState, event, context = {}) {
  const { hasDestination = false } = context;

  switch (currentState) {
    case 'IDLE':
      if (event === 'OPEN_SEARCH') return 'SEARCH';
      if (event === 'SELECT_DEST') return 'VERDICT';
      return 'IDLE';

    case 'SEARCH':
      if (event === 'CANCEL' || event === 'CLOSE') {
        return hasDestination ? 'VERDICT' : 'IDLE';
      }
      if (event === 'SELECT_DEST') return 'VERDICT';
      return 'SEARCH';

    case 'VERDICT':
      if (event === 'CHANGE_DEST' || event === 'OPEN_SEARCH') return 'SEARCH';
      if (event === 'RESET') return 'IDLE';
      return 'VERDICT';

    default:
      return 'IDLE';
  }
}
