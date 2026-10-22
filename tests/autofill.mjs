// Form autofill (P3-07): fields are matched by name and tooltip, values are
// shaped for each field (dates in its format, a choice from its options), and
// the profile round-trips through AES-GCM only with its passphrase.
//
//   node tests/autofill.mjs
import { loadLib, check, eq } from "./lib/load.mjs";

const results = { failed: 0 };
const test = check(results);
const af = await loadLib("autofill");

await test("the acceptance form: Applicant Name, D.O.B. and Pin code", () => {
  eq(af.matchField({ name: "Applicant Name" }), "fullName", "Applicant Name");
  eq(af.matchField({ name: "D.O.B." }), "dob", "D.O.B.");
  eq(af.matchField({ name: "Pin code" }), "pincode", "Pin code");
});

await test("longer phrases win; tooltips and dotted names count", () => {
  for (const [name, key] of [
    ["Father's Name", "fatherName"], ["Name of Mother", "motherName"], ["Email Address", "email"], ["Permanent Address", "address"],
    ["Mobile No.", "phone"], ["candidate_name", "fullName"], ["applicant.dob", "dob"], ["ZIP", "pincode"], ["Surname", "lastName"],
    ["Date of Birth (DD/MM/YYYY)", "dob"], ["State/UT", "state"], ["Signature", null], ["Text1", null],
  ]) eq(af.matchField({ name }), key, name);
  eq(af.matchField({ name: "Text7", tooltip: "Date of birth" }), "dob", "tooltip");
});

await test("values: dates in the field's format, choices from its options, full name from its parts", () => {
  const p = { dob: "2001-08-15", gender: "female", firstName: "Asha", lastName: "Rao", pincode: "560001" };
  eq(af.valueFor("dob", p, { type: "date", dateFormat: "DD/MM/YYYY" }), "15/08/2001", "DD/MM/YYYY");
  eq(af.valueFor("dob", p, { type: "text", dateFormat: "MM-DD-YY" }), "08-15-01", "MM-DD-YY");
  eq(af.valueFor("gender", p, { type: "dropdown", options: ["Male", "Female", "Other"] }), "Female", "option");
  eq(af.valueFor("gender", p, { type: "dropdown", options: ["M", "F"] }), "F", "initial");
  eq(af.valueFor("fullName", p, { type: "text" }), "Asha Rao", "joined name");
  eq(af.valueFor("pincode", p, { type: "checkbox" }), null, "no value for a checkbox");
});

await test("the profile opens only with its passphrase", async () => {
  const sealed = await af.seal({ fullName: "Asha Rao", pincode: "560001" }, "correct horse battery");
  eq(new TextDecoder().decode(sealed.data).includes("Asha"), false, "ciphertext hides the name");
  eq((await af.unseal(sealed, "correct horse battery")).fullName, "Asha Rao", "unsealed");
  let wrong = false;
  await af.unseal(sealed, "wrong").catch((e) => (wrong = e instanceof af.WrongPassphrase));
  eq(wrong, true, "wrong passphrase");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
