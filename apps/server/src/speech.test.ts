import { createDemoProject, type ServerMessage } from "@vizli/shared";
import { VisualSession } from "./session.js";
import { memorySource } from "./test-support.js";
import { EventEmitter } from "node:events";
import * as grpc from "@grpc/grpc-js";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  NvidiaSpeech,
  createRivaClient,
  rivaServiceDefinition,
  NVIDIA_ASR_DEFAULT_FUNCTION_ID,
  type RivaClient,
  type RivaRequest,
  type RivaResponse,
} from "./speech.js";
const callbacks = () => ({
  transcript: vi.fn(),
  state: vi.fn(),
  error: vi.fn(),
});
function mockTransport(ready = true, accept = true) {
  const stream = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  };
  stream.write = vi.fn((_message, callback?: () => void) => {
    if (accept) callback?.();
    return accept;
  });
  stream.cancel = vi.fn();
  const client = {
    waitForReady: vi.fn((_deadline, callback: (error: null) => void) => {
      if (ready) callback(null);
    }),
    streamingRecognize: vi.fn(() => stream),
    close: vi.fn(),
  };
  return { stream, client, transport: client as unknown as RivaClient };
}
afterEach(() => vi.useRealTimers());
describe("NVIDIA streaming speech lifecycle", () => {
  it("groups all top hypotheses by finalized portions without treating alternatives or audio_processed as IDs", () => {
    const mock = mockTransport(),
      cb = callbacks(),
      speech = new NvidiaSpeech("test", {}, cb, mock.transport);
    mock.stream.emit("data", {
      results: [
        {
          is_final: true,
          alternatives: [
            { transcript: "Revenue rose" },
            { transcript: "WRONG" },
          ],
        },
        { is_final: true, alternatives: [{ transcript: "this quarter" }] },
        { alternatives: [{ transcript: "The next" }], audio_processed: 1 },
        { alternatives: [{ transcript: "figure" }], audio_processed: 2 },
      ],
    });
    expect(cb.transcript.mock.calls).toEqual([
      ["Revenue rose this quarter The next figure", false],
    ]);
    mock.stream.emit("data", {
      results: [
        {
          alternatives: [{ transcript: "The next figure" }],
          audio_processed: 3,
        },
      ],
    });
    expect(cb.transcript.mock.calls[1]).toEqual([
      "Revenue rose this quarter The next figure",
      false,
    ]);
    mock.stream.emit("data", {
      results: [{ is_final: true, alternatives: [] }],
    });
    expect(cb.transcript.mock.calls[2]).toEqual([
      "Revenue rose this quarter",
      true,
    ]);
    speech.close();
    mock.stream.emit("data", {
      results: [{ is_final: true, alternatives: [{ transcript: "late" }] }],
    });
    mock.stream.emit("error", { code: grpc.status.CANCELLED });
    expect(cb.transcript).toHaveBeenCalledTimes(3);
    expect(cb.error).not.toHaveBeenCalled();
    expect(mock.stream.cancel).toHaveBeenCalledOnce();
    expect(mock.client.close).toHaveBeenCalledOnce();
  });
  it("retains finalized command prefixes until trailing partials finalize at the session boundary", async () => {
    vi.useFakeTimers();
    const messages: ServerMessage[] = [],
      session = new VisualSession((message) => messages.push(message));
    memorySource(createDemoProject().scenes[2]!).attach(session);
    const mock = mockTransport(),
      cb = callbacks();
    cb.transcript.mockImplementation((text, final) =>
      session.speech(text, final),
    );
    const speech = new NvidiaSpeech("test", {}, cb, mock.transport);
    try {
      mock.stream.emit("data", {
        results: [
          { is_final: true, alternatives: [{ transcript: "add a" }] },
          { is_final: false, alternatives: [{ transcript: "ca" }] },
        ],
      });
      await vi.advanceTimersByTimeAsync(350);
      expect(messages.some((message) => message.type === "action")).toBe(false);
      mock.stream.emit("data", {
        results: [{ is_final: true, alternatives: [{ transcript: "cache" }] }],
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(
        messages.filter((message) => message.type === "action"),
      ).toMatchObject([
        { type: "action", action: { type: "add_node", label: "Cache" } },
      ]);
      expect(cb.transcript.mock.calls).toEqual([
        ["add a ca", false],
        ["add a cache", true],
      ]);
    } finally {
      speech.close();
      session.close();
    }
  });
  it("bounds queued audio when gRPC is backpressured", () => {
    const mock = mockTransport(true, false),
      cb = callbacks(),
      speech = new NvidiaSpeech("test", {}, cb, mock.transport);
    for (let i = 0; i < 5; i++) speech.audio(Buffer.alloc(32000));
    expect(cb.error).toHaveBeenCalledWith(
      expect.stringContaining("fell behind"),
    );
    expect(cb.state).toHaveBeenCalledWith("error");
    expect(mock.stream.cancel).toHaveBeenCalledOnce();
    speech.close();
    expect(mock.client.close).toHaveBeenCalledOnce();
  });
  it("enforces readiness deadline and does not expose provider error details", async () => {
    vi.useFakeTimers();
    const mock = mockTransport(false),
      cb = callbacks();
    new NvidiaSpeech("test", {}, cb, mock.transport);
    await vi.advanceTimersByTimeAsync(10001);
    expect(cb.error).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    expect(mock.client.close).toHaveBeenCalledOnce();
    const active = mockTransport(),
      cb2 = callbacks();
    new NvidiaSpeech("test", {}, cb2, active.transport);
    active.stream.emit("error", {
      code: grpc.status.UNAUTHENTICATED,
      details: "secret-token",
    });
    expect(cb2.error.mock.calls[0]![0]).not.toContain("secret-token");
    expect(cb2.error.mock.calls[0]![0]).toContain("NVIDIA_API_KEY");
  });
  it("uses TLS endpoint syntax and prevents URL/insecure scheme overrides", () => {
    expect(() => createRivaClient("http://localhost:5000")).toThrow(
      "hostname:port",
    );
    expect(() => createRivaClient("grpc://localhost:5000")).toThrow(
      "hostname:port",
    );
  });
});
describe("real local Riva gRPC protocol", () => {
  it("sends authenticated config then PCM before receiving metadata, and cancels cleanly", async () => {
    const server = new grpc.Server(),
      received: RivaRequest[] = [];
    let call: grpc.ServerDuplexStream<RivaRequest, RivaResponse> | undefined;
    server.addService(rivaServiceDefinition, {
      streamingRecognize: (
        incoming: grpc.ServerDuplexStream<RivaRequest, RivaResponse>,
      ) => {
        call = incoming;
        incoming.on("error", () => {});
        incoming.on("data", (message: RivaRequest) => {
          received.push(message);
          if (message.audio_content) {
            incoming.write({
              results: [
                {
                  alternatives: [{ transcript: "highlight revenue" }],
                  is_final: false,
                },
              ],
            });
            incoming.write({
              results: [
                {
                  alternatives: [{ transcript: "highlight revenue" }],
                  is_final: true,
                },
              ],
            });
          }
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        grpc.ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    const cb = callbacks(),
      transport = createRivaClient(
        `127.0.0.1:${port}`,
        grpc.credentials.createInsecure(),
      );
    const speech = new NvidiaSpeech("test-key", {}, cb, transport);
    try {
      speech.audio(Buffer.from([1, 0, 2, 0]));
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[0]).toMatchObject({
        streaming_config: {
          config: {
            encoding: "LINEAR_PCM",
            sample_rate_hertz: 16000,
            language_code: "en-US",
            audio_channel_count: 1,
            max_alternatives: 1,
            enable_automatic_punctuation: true,
          },
          interim_results: true,
        },
      });
      expect(received[0]!.audio_content).toBeUndefined();
      expect(received[1]!.streaming_config).toBeUndefined();
      expect(received[1]!.audio_content).toEqual(Buffer.from([1, 0, 2, 0]));
      expect(call!.metadata.get("authorization")).toEqual(["Bearer test-key"]);
      expect(call!.metadata.get("function-id")).toEqual([
        NVIDIA_ASR_DEFAULT_FUNCTION_ID,
      ]);
      await vi.waitFor(() =>
        expect(cb.transcript.mock.calls).toEqual([
          ["highlight revenue", false],
          ["highlight revenue", true],
        ]),
      );
      expect(cb.state).toHaveBeenCalledWith("listening");
      speech.close();
      await vi.waitFor(() => expect(call!.cancelled).toBe(true));
      expect(cb.error).not.toHaveBeenCalled();
    } finally {
      speech.close();
      server.forceShutdown();
    }
  });
});
