export function isExpiredPayment(view) {
  return view?.status === "expired" && view.checkingPayment !== true;
}
