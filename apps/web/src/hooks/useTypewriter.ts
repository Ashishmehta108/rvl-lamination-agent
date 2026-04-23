import { useState, useEffect, useRef } from "react";

export function useTypewriter(target: string, active: boolean, speed = 8) {
  const [displayed, setDisplayed] = useState("");
  const idx = useRef(0);

  useEffect(() => {
    if (!active) {
      setDisplayed(target);
      return;
    }

    idx.current = 0;
    setDisplayed("");

    const iv = setInterval(() => {
      idx.current += speed;
      setDisplayed(target.slice(0, idx.current));
      if (idx.current >= target.length) {
        clearInterval(iv);
      }
    }, 16);

    return () => clearInterval(iv);
  }, [target, active, speed]);

  return active ? displayed : target;
}
