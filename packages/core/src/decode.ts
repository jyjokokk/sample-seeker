import ffmpegStatic from "ffmpeg-static";

export const FFMPEG_PATH = (ffmpegStatic as unknown as string | null) ?? "ffmpeg";

/**
 * Decode an audio file to mono float32 PCM.
 *
 * TODO: spawn ffmpeg (FFMPEG_PATH) with something like
 *   -i <path> -ac 1 -ar <sampleRate> -f f32le pipe:1
 * and turn stdout into a Float32Array.
 */
export async function decode(path: string, sampleRate: number): Promise<Float32Array> {
  throw new Error("decode: not implemented");
}
