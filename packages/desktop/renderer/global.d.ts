// Shape of the API exposed by src/preload.ts.
interface DawState {
  connected: boolean;
  tempo: number | null;
  camelot: string | null;
  selection: { path: string } | null;
}

interface Window {
  sf: {
    call(method: "search" | "similar" | "roots" | "index", ...args: unknown[]): Promise<any>;
    addFolder(): Promise<string[]>;
    getDawState(): Promise<DawState>;
    startDrag(path: string): void;
    on(channel: "engine-status" | "index-progress" | "daw-state", cb: (data: any) => void): void;
  };
}
