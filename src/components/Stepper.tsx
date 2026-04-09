import type { WizardStep } from "../types";

interface StepperProps {
  current: WizardStep;
}

const STEPS: { id: WizardStep; label: string }[] = [
  { id: "apple", label: "Apple Music" },
  { id: "lastfm", label: "Last.fm" },
  { id: "cloudflare", label: "Cloudflare" },
  { id: "deploy", label: "Deploy" },
];

export function Stepper({ current }: StepperProps) {
  const currentIdx = STEPS.findIndex((s) => s.id === current);

  return (
    <div className="stepper">
      {STEPS.map((step, idx) => {
        const status =
          idx < currentIdx ? "done" : idx === currentIdx ? "active" : "pending";
        return (
          <div key={step.id} className={`step ${status}`}>
            <div className="step-dot">{idx < currentIdx ? "✓" : idx + 1}</div>
            <div className="step-label">{step.label}</div>
            {idx < STEPS.length - 1 && <div className="step-connector" />}
          </div>
        );
      })}
    </div>
  );
}
