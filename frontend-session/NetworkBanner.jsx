import { useEffect, useState } from "react";

/** Subscribes to a NetworkMonitor and re-renders on every change. */
export function useNetworkStatus(monitor) {
  const [state, setState] = useState(monitor.getState());
  useEffect(() => monitor.subscribe(setState), [monitor]);
  return state;
}

const COLORS = { offline: "#b91c1c", unstable: "#b45309", recovered: "#15803d" };

/**
 * A slim bar across the top: red "No network connection", amber "Your network is unstable", and a green "You're back online" for 3 seconds.
 * Place it once near the root of the app:  <NetworkBanner monitor={monitor} />
 */
export default function NetworkBanner({ monitor }) {
  const s = useNetworkStatus(monitor);
  const [showRecovered, setShowRecovered] = useState(false);

  useEffect(() => {
    if (!s.recovered) return setShowRecovered(false);
    setShowRecovered(true);
    const t = setTimeout(() => setShowRecovered(false), 3000);
    return () => clearTimeout(t);
  }, [s.recovered, s.since]);

  const kind = s.status === "offline" ? "offline" : s.status === "unstable" ? "unstable" : showRecovered ? "recovered" : null;
  if (!kind) return null;
  return (
    <div
      role={kind === "offline" ? "alert" : "status"}
      aria-live={kind === "offline" ? "assertive" : "polite"}
      style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 10000, padding: "8px 16px", textAlign: "center", fontSize: 14, fontWeight: 600, color: "#fff", background: COLORS[kind] }}
    >
      {s.message}
    </div>
  );
}
