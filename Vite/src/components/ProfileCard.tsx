// `idLabel`/`idValue` are optional. The old version always printed "Patient ID:",
// so the physician card read "Patient ID: Provider ID: DR-2048".
function ProfileCard({ name, role, idLabel, idValue }: { name: string; role: string; idLabel?: string; idValue?: string }) {
  return (
    <section className="profile-card">
      <h2>{name}</h2>
      <p>
        <strong>Role:</strong> {role}
      </p>
      {idValue && (
        <p>
          <strong>{idLabel || "ID"}:</strong> {idValue}
        </p>
      )}
    </section>
  );
}

export default ProfileCard;
