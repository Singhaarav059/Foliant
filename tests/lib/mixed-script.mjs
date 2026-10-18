// The text of tests/fixtures/mixed-script.pdf (tests/make-mixed-script.mjs):
// a form in English and Hindi, three lines mixing both scripts.
export const MIXED_LINES = [
  "Application for a new ration card, district office Lucknow",
  "नए राशन कार्ड के लिए आवेदन, जिला कार्यालय लखनऊ",
  "Name of applicant: Priya Sharma, age 34, ward number 12",
  "आवेदक का नाम प्रिया शर्मा है और उनकी आयु चौंतीस वर्ष है",
  "Address / पता: 18 Gandhi Road, Hazratganj / हज़रतगंज",
  "Family members / परिवार के सदस्य: four / चार",
  "मैं घोषणा करता हूँ कि ऊपर दी गई जानकारी सही है",
  "I declare that the information given above is correct",
  "Signature / हस्ताक्षर: please sign below / कृपया नीचे हस्ताक्षर करें",
];

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z0-9]/;
// The words of one script, in reading order, for a per-script error rate.
export const wordsIn = (text, script) =>
  text.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{M}\p{N}]/gu, "")).filter((w) => w && (script === "hin" ? DEVANAGARI : LATIN).test(w));
