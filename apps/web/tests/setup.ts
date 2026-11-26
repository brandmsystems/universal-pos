/**
 * React 19 refuses `act()` unless the environment declares itself, and the
 * error it throws names neither the flag nor where to set it.
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
