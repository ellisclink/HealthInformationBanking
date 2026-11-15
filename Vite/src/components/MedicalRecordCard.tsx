import { Link } from "react-router-dom";

function MedicalRecordCard({ title, description }: { title: string; description: string }) {
  return (
    <article className="record-card">
      <h3>{title}</h3>
      <p>{description}</p>

      <Link className="secondary-button" to="/medical-records">
        View Records
      </Link>
    </article>
  );
}

export default MedicalRecordCard;
