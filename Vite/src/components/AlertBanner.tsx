// Info banners use role="status". role="alert" makes screen readers interrupt and
// read the banner on every page load, which is meant for real errors only.
function AlertBanner({ message, type = "info" }: { message: string; type?: string }) {
  return (
    <div className={`alert-banner alert-${type}`} role={type === "error" || type === "warning" ? "alert" : "status"}>
      {message}
    </div>
  );
}

export default AlertBanner;
