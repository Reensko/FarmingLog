import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// === Service Worker Registration ===
// Only in production builds – the dev server doesn't need it
// and SW caching can make development confusing
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        console.log("✓ Service Worker aktiv:", reg.scope);

        // Detect updates and prompt user to reload
        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              // A new version is ready – ask the user if they want to update
              if (window.confirm("Eine neue Version ist verfügbar. Jetzt aktualisieren?")) {
                window.location.reload();
              }
            }
          });
        });
      })
      .catch((err) => console.warn("Service Worker Registrierung fehlgeschlagen:", err));
  });
}

// === Mount App ===
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
