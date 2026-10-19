function ShareButton({ onClick, text = "Generate Sharing Code" }: {onClick: () => void, text: string}) {
  return (
    <button className="primary-button" type="button" onClick={onClick}>
      {text}
    </button>
  );
}

export default ShareButton;