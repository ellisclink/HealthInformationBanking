import { Link } from "react-router-dom";

// "View Records" used to be a button with no onClick, so it did nothing.
// It now opens the Medical Records page.
function MedicalRecordCard({ title, count, description }: { title: string; count: number; description: string }) {
  return (
    <article className="record-card">
      <h3>{title}</h3>
      <p className="record-count">{count}</p>
      <p>{description}</p>

      <Link className="secondary-button" to="/medical-records">
        View Records
      </Link>
    </article>
  );
}

export default MedicalRecordCard;
