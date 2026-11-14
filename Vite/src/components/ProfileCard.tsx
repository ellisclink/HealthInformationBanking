// `idLabel`/`idValue` are optional; the ID line only shows when a value is given.
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
