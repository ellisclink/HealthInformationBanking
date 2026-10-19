function SearchBar({ value, onChange, placeholder = "Search records..." }: {value: string, onChange: (event: React.ChangeEvent<HTMLInputElement>) => void, placeholder: string}) {
  return (
    <div className="search-bar">
      <label htmlFor="record-search">Search Medical Records</label>

      <input
        id="record-search"
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
    </div>
  );
}

export default SearchBar;