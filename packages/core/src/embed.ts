/**
 * Turns audio and text into vectors in the same space.
 *
 * TODO: implement with transformers.js CLAP, e.g. model "Xenova/clap-htsat-unfused":
 *   AutoProcessor + ClapAudioModelWithProjection  → audio embeddings (48 kHz input)
 *   AutoTokenizer + ClapTextModelWithProjection    → text embeddings
 * Remember to L2-normalise the outputs.
 */
export interface Embedder {
  readonly sampleRate: number;
  embedAudio(signal: Float32Array): Promise<Float32Array>;
  embedText(text: string): Promise<Float32Array>;
}

export class ClapEmbedder implements Embedder {
  readonly sampleRate = 48_000;

  static async load(_opts: { cacheDir?: string } = {}): Promise<ClapEmbedder> {
    // TODO: load models (import("@huggingface/transformers"), set env.cacheDir)
    return new ClapEmbedder();
  }

  async embedAudio(_signal: Float32Array): Promise<Float32Array> {
    throw new Error("embedAudio: not implemented");
  }

  async embedText(_text: string): Promise<Float32Array> {
    throw new Error("embedText: not implemented");
  }
}
