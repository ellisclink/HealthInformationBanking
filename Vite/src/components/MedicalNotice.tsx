import { Link } from "react-router-dom";

// A short, always-visible reminder placed on the pages that show results, ranges, warnings or summaries.
// It is deliberately brief and in plain words (the FTC expects disclaimers to be clear and easy to see); the full text is at /disclaimer.
function MedicalNotice({ kind = "results" }: { kind?: "results" | "warnings" | "summary" }) {
  const text = {
    results: "Ranges and flags are general information, not a diagnosis. “Outside the range” does not always mean a problem, and “in range” does not always mean you are fine. Ask your doctor what a result means for you.",
    warnings: "These warnings cover only a short list of common medicines and are not a pharmacist’s review. No warning does not mean a medicine is safe for you. Do not start, stop or change a medicine without asking your doctor or pharmacist.",
    summary: "This summary only lists what you have recorded. It is not medical advice, and it can be wrong or out of date. Check it before you share it.",
  }[kind];
  return (
    <p className="notice medical-notice no-print" role="note">
      <strong>Not medical advice.</strong> {text} <Link to="/disclaimer">Medical Disclaimer</Link>. In an emergency, call your local emergency number.
    </p>
  );
}

export default MedicalNotice;
