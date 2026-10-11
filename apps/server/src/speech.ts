import * as grpc from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const protoRoot = fileURLToPath(
  new URL("../vendor/nvidia-riva/", import.meta.url),
);
const definition = loadSync(resolve(protoRoot, "riva/proto/riva_asr.proto"), {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: false,
  oneofs: true,
  includeDirs: [protoRoot],
});
const packages = grpc.loadPackageDefinition(definition) as unknown as {
  nvidia: {
    riva: { asr: { RivaSpeechRecognition: grpc.ServiceClientConstructor } };
  };
};
export const rivaServiceDefinition =
  packages.nvidia.riva.asr.RivaSpeechRecognition.service;
export const NVIDIA_ASR_DEFAULT_ENDPOINT = "grpc.nvcf.nvidia.com:443";
export const NVIDIA_ASR_DEFAULT_FUNCTION_ID =
  "bb0837de-8c7b-481f-9ec8-ef5663e9c1fa";
export type NvidiaSpeechOptions = {
  endpoint?: string;
  functionId?: string;
  languageCode?: string;
};
export type SpeechCallbacks = {
  transcript: (text: string, final: boolean) => void;
  state: (state: "listening" | "off" | "error") => void;
  error: (message: string) => void;
};
export type RivaRequest = {
  streaming_config?: {
    config: {
      encoding: string;
      sample_rate_hertz: number;
      language_code: string;
      audio_channel_count: number;
      max_alternatives: number;
      enable_automatic_punctuation: boolean;
    };
    interim_results: boolean;
  };
  audio_content?: Buffer;
};
export type RivaResponse = {
  results?: {
    alternatives?: { transcript?: string }[];
    is_final?: boolean;
    audio_processed?: number;
  }[];
};
export type RivaClient = grpc.Client & {
  streamingRecognize: (
    metadata: grpc.Metadata,
  ) => grpc.ClientDuplexStream<RivaRequest, RivaResponse>;
};
/** Production always passes TLS credentials. The optional credentials argument supports local protocol tests only. */
export function createRivaClient(
  endpoint: string,
  channelCredentials = grpc.credentials.createSsl(),
): RivaClient {
  if (!/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(endpoint))
    throw new Error(
      "NVIDIA_ASR_ENDPOINT must be a hostname:port; hosted speech requires TLS.",
    );
  return new packages.nvidia.riva.asr.RivaSpeechRecognition(
    endpoint,
    channelCredentials,
    {
      "grpc.max_receive_message_length": 1024 * 1024,
      "grpc.max_send_message_length": 64 * 1024,
    },
  ) as unknown as RivaClient;
}
/** NVIDIA hosted Nemotron ASR via Riva bidirectional gRPC. No Deepgram turn/sequence assumptions. */
export class NvidiaSpeech {
  private client: RivaClient;
  private stream?: grpc.ClientDuplexStream<RivaRequest, RivaResponse>;
  private closed = false;
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private pendingBytes = 0;
  private blocked = false;
  private finalizedPrefix = "";
  private readinessTimer?: ReturnType<typeof setTimeout>;
  constructor(
    key: string,
    options: NvidiaSpeechOptions,
    private callbacks: SpeechCallbacks,
    transport?: RivaClient,
  ) {
    const language = options.languageCode ?? "en-US";
    const functionId = options.functionId ?? NVIDIA_ASR_DEFAULT_FUNCTION_ID;
    if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(language))
      throw new Error("NVIDIA_ASR_LANGUAGE_CODE must be a valid language tag.");
    if (!/^[a-fA-F0-9-]{36}$/.test(functionId))
      throw new Error(
        "NVIDIA_ASR_FUNCTION_ID must be the hosted model function ID.",
      );
    this.client =
      transport ??
      createRivaClient(options.endpoint ?? NVIDIA_ASR_DEFAULT_ENDPOINT);
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${key}`);
    metadata.set("function-id", functionId);
    this.readinessTimer = setTimeout(
      () =>
        this.fail(
          "NVIDIA speech connection timed out. Check your network and hosted endpoint.",
        ),
      10000,
    );
    this.readinessTimer.unref?.();
    this.client.waitForReady(Date.now() + 10000, (error) => {
      if (this.closed) return;
      if (error) {
        this.fail(
          "NVIDIA speech connection failed. Check your network and hosted endpoint.",
        );
        return;
      }
      clearTimeout(this.readinessTimer);
      this.readinessTimer = undefined;
      try {
        const stream = this.client.streamingRecognize(metadata);
        this.stream = stream;
        stream.on("data", (response: RivaResponse) => this.receive(response));
        stream.on("drain", () => {
          if (this.closed) return;
          this.blocked = false;
          this.flush();
        });
        stream.on("error", (failure: grpc.ServiceError) => {
          if (this.closed) return;
          this.fail(
            failure.code === grpc.status.UNAUTHENTICATED ||
              failure.code === grpc.status.PERMISSION_DENIED
              ? "NVIDIA speech access was denied. Check NVIDIA_API_KEY and the hosted model entitlement."
              : "NVIDIA speech stream failed. Check your connection and try again.",
          );
        });
        stream.on("status", (status: grpc.StatusObject) => {
          if (!this.closed && status.code !== grpc.status.OK)
            this.fail(
              "NVIDIA speech stream ended with an error. Check the hosted model configuration.",
            );
        });
        stream.on("end", () => {
          if (this.closed) return;
          this.close();
          callbacks.state("off");
        });
        // Riva requires config as message one. Do not wait for response metadata before sending audio.
        this.blocked = !stream.write(
          {
            streaming_config: {
              config: {
                encoding: "LINEAR_PCM",
                sample_rate_hertz: 16000,
                language_code: language,
                audio_channel_count: 1,
                max_alternatives: 1,
                enable_automatic_punctuation: true,
              },
              interim_results: true,
            },
          },
          (error?: Error | null) => {
            if (error)
              this.fail("NVIDIA speech rejected the stream configuration.");
          },
        );
        if (this.closed) return;
        callbacks.state("listening");
        this.flush();
      } catch {
        this.fail(
          "Could not initialize NVIDIA speech recognition. Check the hosted model configuration.",
        );
      }
    });
  }
  private receive(response: RivaResponse) {
    if (this.closed) return;
    if (!Array.isArray(response.results)) return;
    if (response.results.length > 100) {
      this.fail("NVIDIA speech returned an unexpectedly large response.");
      return;
    }
    // A finalized Riva result is only an audio portion. When trailing partials
    // coexist, retain that finalized prefix and expose ONE cumulative update so
    // a partial cannot cancel a separate final command in VisualSession.
    const finalized: string[] = [];
    const pending: string[] = [];
    let hasPartial = false;
    let sawFinal = false;
    for (const result of response.results) {
      const text = result.alternatives?.[0]?.transcript?.trim() ?? "";
      if (result.is_final === true) {
        sawFinal = true;
        if (text) (hasPartial ? pending : finalized).push(text);
      } else {
        hasPartial = true;
        if (text) pending.push(text);
      }
    }
    if (!sawFinal && !hasPartial) return;
    this.finalizedPrefix = [this.finalizedPrefix, ...finalized]
      .filter(Boolean)
      .join(" ")
      .slice(-4000);
    const text = [this.finalizedPrefix, ...pending]
      .filter(Boolean)
      .join(" ")
      .slice(-4000);
    if (hasPartial) {
      if (text) this.callbacks.transcript(text, false);
    } else {
      this.finalizedPrefix = "";
      this.callbacks.transcript(text, true);
    }
  }

  private fail(message: string) {
    if (this.closed) return;
    this.close();
    this.callbacks.error(message);
    this.callbacks.state("error");
  }
  audio(buffer: Buffer) {
    if (this.closed) return;
    if (
      buffer.length === 0 ||
      buffer.length > 32000 ||
      buffer.length % 2 !== 0
    ) {
      this.fail("Send valid PCM16 mono audio chunks of at most one second.");
      return;
    }
    if (this.queuedBytes + this.pendingBytes + buffer.length > 128000) {
      this.fail("NVIDIA speech upload fell behind. Restart the microphone.");
      return;
    }
    this.queued.push(Buffer.from(buffer));
    this.queuedBytes += buffer.length;
    this.flush();
  }
  private flush() {
    if (this.closed || !this.stream || this.blocked) return;
    while (this.queued.length && !this.blocked && !this.closed) {
      const chunk = this.queued.shift()!;
      this.queuedBytes -= chunk.length;
      this.pendingBytes += chunk.length;
      try {
        this.blocked = !this.stream.write(
          { audio_content: chunk },
          (error?: Error | null) => {
            this.pendingBytes = Math.max(0, this.pendingBytes - chunk.length);
            if (error) this.fail("NVIDIA speech audio upload failed.");
          },
        );
      } catch {
        this.fail("NVIDIA speech audio upload failed.");
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readinessTimer);
    this.readinessTimer = undefined;
    this.queued = [];
    this.queuedBytes = 0;
    this.pendingBytes = 0;
    this.finalizedPrefix = "";
    this.stream?.cancel();
    this.client.close();
  }
}
