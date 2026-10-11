# Vendored NVIDIA Riva protocol definitions

Source: https://github.com/nvidia-riva/common
Pinned revision: `268890b7286031a6d4950e34f7ce13ed0d4ce621`

Unmodified files from `riva/proto/`: `riva_asr.proto`, `riva_audio.proto`, `riva_common.proto`.

NVIDIA portions are MIT licensed; the original `LICENSE` is included. `riva_asr.proto` also contains inherited Google Apache-2.0 notices, preserved verbatim; `LICENSE-APACHE-2.0` contains that license text. Source files retain all copyright/license headers. No generated binary or model weights are bundled.

Loaded at runtime with @grpc/proto-loader. Hosted NVIDIA endpoint documentation: https://build.nvidia.com/nvidia/nemotron-asr-streaming/api . API-key credentials remain on the server. Local gRPC tests use insecure loopback transport solely as an injected test client; production construction always uses TLS.
