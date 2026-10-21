import { App } from "./app";
import { createBridge } from "./bridge";

/** Start the application. */
function boot(): void {
  const root = document.getElementById("app");
  if (!root) {
    throw new Error("The application root element is missing.");
  }
  const bridge = createBridge();
  const app = new App({ root, bridge });
  void app.start();
}

boot();
