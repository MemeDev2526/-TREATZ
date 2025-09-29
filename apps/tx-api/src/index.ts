import express from "express";
const app = express(); app.use(express.json());
app.post("/prepare", (req, res)=> res.json({ signUrl: "https://your-web.example.com" }));
app.listen(process.env.PORT || 8080, ()=> console.log("tx-api up"));
