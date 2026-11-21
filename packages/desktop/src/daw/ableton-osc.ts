/**
 * Ableton Live via AbletonOSC (a remote script exposing the Live Object Model over OSC).
 *   API reference: https://github.com/ideoforms/AbletonOSC#documentation
 *
 * AbletonOSC listens on 11000 and replies to the sender on 11001.
 * Listeners follow the pattern: /live/song/start_listen/<prop> → updates on /live/song/get/<prop>
 */
import { Client, Server } from "node-osc";
import { emptyState, type DawAdapter, type DawState } from "./types";

type OscArg = string | number | boolean;

export class AbletonOscAdapter implements DawAdapter {
  readonly name = "Ableton Live (AbletonOSC)";

  private client = new Client("127.0.0.1", 11000);
  private server: Server | null = null;
  private state: DawState = emptyState();
  private listeners: ((s: DawState) => void)[] = [];

  async connect(): Promise<void> {
    this.server = new Server(11001, "127.0.0.1");
    this.server.on("message", ([address, ...args]: [string, ...OscArg[]]) => this.handle(address, args));

    // Worked example: tempo. Ask once, then subscribe to changes.
    await this.client.send("/live/song/get/tempo");
    await this.client.send("/live/song/start_listen/tempo");

    // TODO: key → /live/song/get/root_note + /live/song/get/scale_name (+ listeners)
    // TODO: selection → there is no selected_clip listener, so listen to
    //       /live/view/start_listen/selected_track and .../selected_scene,
    //       then query /live/view/get/selected_clip and /live/clip/get/file_path
    // TODO: detect "Live not running": AbletonOSC answers /live/test, so ping it
    //       periodically and update state.connected
  }

  private handle(address: string, args: OscArg[]) {
    switch (address) {
      case "/live/song/get/tempo":
        this.update({ connected: true, tempo: Number(args[0]) });
        break;
      // TODO: handle the replies for key and selection
    }
  }

  private update(patch: Partial<DawState>) {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb(this.state);
  }

  onState(cb: (state: DawState) => void): void {
    this.listeners.push(cb);
  }

  async dispose(): Promise<void> {
    await this.client.send("/live/song/stop_listen/tempo")?.catch(() => {});
    await this.client.close();
    await this.server?.close();
  }
}
