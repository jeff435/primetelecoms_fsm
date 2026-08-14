var admin = require("firebase-admin");

var serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://planning-with-ai-f9dd4-default-rtdb.asia-southeast1.firebasedatabase.app"
});

console.log("Firebase Admin SDK initialized successfully.");
