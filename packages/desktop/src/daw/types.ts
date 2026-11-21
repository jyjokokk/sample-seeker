/**
 * DAW integration boundary. The rest of the app only knows about these types,
 * so swapping AbletonOSC for a forked script, Bitwig, Reaper… means writing a
 * new adapter, nothing else.
 */
export interface DawState {
  connected: boolean;
  tempo: number | null;
  /** Project key in Camelot notation ("8A"), or null if unknown. */
  camelot: string | null;
  /** The audio file behind whatever is selected in the DAW. */
  selection: { path: string } | null;
}

export interface DawAdapter {
  readonly name: string;
  connect(): Promise<void>;
  onState(cb: (state: DawState) => void): void;
  dispose(): Promise<void>;
}

export const emptyState = (): DawState => ({
  connected: false,
  tempo: null,
  camelot: null,
  selection: null,
});
