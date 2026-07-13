import { searchReplacements } from "./scoring-core.js";

self.onmessage = (event) => {
  if (event.data?.type !== "search") return;
  try {
    const result = searchReplacements(event.data.payload, (progress) => {
      self.postMessage({ type: "progress", progress });
    });
    self.postMessage({ type: "complete", result });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  }
};
