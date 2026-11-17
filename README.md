# Medicine Expiry Date Detection System

Web app that reads the expiry date from a photo (or live camera) of a medicine strip/box using OCR (Tesseract.js) and tells you if it is Expired, Expiring soon, or Safe.

## Run
1. Put `index.html`, `style.css`, `app.js` in one folder (e.g. `medicine-expiry-detector/`).
2. Open the folder in VS Code and install the **Live Server** extension.
3. Right-click `index.html` -> **Open with Live Server** (runs at http://127.0.0.1:5500).
4. Internet is needed the first time to load the OCR engine and language data (then cached by the browser).

## Features
- Upload image or use camera (works on localhost)
- In-browser OCR, no backend
- Understands formats: `EXP 08/2027`, `08/27`, `15-03-2026`, `AUG 2027`, `2027-08`, `MFG ... EXP ...`
- Status: Expired / <30 days / <90 days / Safe
- Manual date entry fallback and scan history (localStorage)

## Why it does not lag
- OCR worker is created once and reused
- Images are downscaled to max 1000px and converted to high-contrast grayscale before OCR
- Only one scan runs at a time

## Tech
HTML, CSS, JavaScript, Tesseract.js
