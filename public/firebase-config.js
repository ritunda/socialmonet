// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCuMfjiLqXGfYGsO5dA76knDerUkZUgLF4",
  authDomain: "ritunda.firebaseapp.com",
  databaseURL: "https://ritunda.firebaseio.com",
  projectId: "ritunda",
  storageBucket: "ritunda.firebasestorage.app",
  messagingSenderId: "347241703528",
  appId: "1:347241703528:web:2e6653dd4e6a43c784b3dd",
  measurementId: "G-RS76HJ2GP7"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Facebook OAuth settings (replace with your Facebook App ID)
const REDIRECT_URI = window.location.origin + "/dashboard.html";
const FB_APP_ID = "YOUR_FACEBOOK_APP_ID";   // <-- REPLACE THIS