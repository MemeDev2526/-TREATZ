import { useState } from "react";

export default function Home() {
  const [amount, setAmount] = useState("");
  const [choice, setChoice] = useState(1);

  return (
    <main style={{ padding: 24 }}>
      <h1>$TREATZ — Trick or Treat Flip</h1>
      <p>
        This is a placeholder Next.js page. Replace this file with the full UI
        implementation from the provided blueprint.
      </p>
    </main>
  );
}
