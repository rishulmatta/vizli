export async function captureAudio(onData: (data: ArrayBuffer) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule("/pcm-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "vizli-pcm");
    const silent = context.createGain();
    silent.gain.value = 0;
    node.port.onmessage = (e) => onData(e.data as ArrayBuffer);
    source.connect(node);
    node.connect(silent);
    silent.connect(context.destination);
    await context.resume();
    return () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void context?.close();
    };
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    void context?.close();
    throw error;
  }
}
