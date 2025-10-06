import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import session from "express-session";
import passport from "passport";
import {Strategy} from "passport-local";
import env from "dotenv";
import bcrypt from "bcrypt";
import path from "path";
import {fileURLToPath} from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;
const saltRounds = 10;
env.config({ quiet: true });
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({extended: true}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 1000*60*60*24,
    }
}));

app.use(passport.initialize());
app.use(passport.session());

const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: Number(process.env.PG_PORT || 5432),
    ssl: {
    rejectUnauthorized: false // supabase pooler vyžaduje SSL 
  } 
});
db.connect();

app.get("/", (req, res) => {
    res.render("index.ejs");
});

app.get("/login", (req, res) => {
    res.render("login.ejs");
});

app.get("/register", (req, res) => {
    res.render("register.ejs");
});

app.get("/home", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const userId = req.user.id;

  try {
    // 1. Get actual saved days from the DB
    const result = await db.query(
      "SELECT * FROM kalendare WHERE id = $1",
      [userId]
    );
    const filledDays = result.rows;

    // 2. Generate 30-day skeleton
    const daysData = [];
    for (let i = 1; i <= 30; i++) {
      const existing = filledDays.find(d => d.cislo === i);
      daysData.push({
        cislo: i,
        motivace: existing ? existing.motivace : 0,
        spokojenost: existing ? existing.spokojenost : 0
      });
    }

    // 3. Check if day 30 is filled
    const day30 = daysData.find(day => day.cislo === 30);
    const goalReachedPrompt = day30 && (day30.motivace > 0 || day30.spokojenost > 0);

    // 4. Get user info
    const userResult = await db.query("SELECT * FROM uzivatele WHERE id = $1", [userId]);
    const user = userResult.rows[0];

    res.render("home.ejs", {
      user,
      daysData,
      goalReachedPrompt,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading calendar");
  }
});


app.post("/submit-goal-result", async (req, res) => {
  if (!req.isAuthenticated()) return res.redirect("/");

  const userId = req.user.id;
  const dosazeno = req.body.dosazeno === "true"; // Convert string to boolean

  try {
    await db.query("UPDATE uzivatel SET dosazeno = $1 WHERE id = $2", [dosazeno, userId]);
    res.redirect("/home");
  } catch (err) {
    console.error("Error saving goal result:", err);
    res.status(500).send("Failed to save goal result.");
  }
});


app.post("/register", async (req, res) => {
     console.log("Req body:", req.body);
    const email = req.body.email; 
    const jmeno = req.body.jmeno;     
    const typ = req.body.typ;       
    const cil = req.body.cil;   
    const heslo = req.body.heslo;
    console.log('heslo:', heslo);
    console.log('saltRounds:', saltRounds);

  try {
    // 1. Kontrola, jestli už email existuje
    const checkResult = await db.query("SELECT * FROM uzivatele WHERE email = $1", [email]);

    if (checkResult.rows.length > 0) {
      return res.send("Email already exists. Try logging in.");
    }

    // 2. Hashování hesla
    const hashedPassword = await bcrypt.hash(heslo, saltRounds);

    // 3. Vložení nového uživatele do databáze
    const result = await db.query(
      "INSERT INTO uzivatele (email, jmeno, typ, cil, heslo) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [email, jmeno, typ, cil, hashedPassword]
    );

    const uzivatel = result.rows[0];

    // 4. Automatické přihlášení uživatele
    req.login(uzivatel, (err) => {
      if (err) {
        console.error("Login error:", err);
        return res.status(500).send("Login failed after registration.");
      }

      // Přesměrování po úspěšném přihlášení
      res.redirect("/home");
    });
  } catch (err) {
    console.error("Error during registration:", err);
    res.status(500).send("Server error during registration.");
  }
});

app.post("/login", passport.authenticate("local", {
  successRedirect: "/home",
  failureRedirect: "/login"
}));

app.get("/logout", (req, res) => {
  req.logout((err) => {
    if(err) console.log(err);
    res.redirect("/");
  });
});

app.post("/save-day", async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect("/");
  }

  const userId = req.user.id;
  const { cislo, motivace, spokojenost } = req.body;

  try {
    await db.query(`
      INSERT INTO kalendare (cislo, id, motivace, spokojenost)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (cislo, id) DO UPDATE 
        SET motivace = EXCLUDED.motivace, spokojenost = EXCLUDED.spokojenost
    `, [cislo, userId, motivace, spokojenost]);

    res.redirect("/home");
  } catch (err) {
    console.error("Error saving day data:", err);
    res.status(500).send("Chyba při ukládání dat.");
  }
});

passport.use(new Strategy(async function verify(email, heslo, cb){
    try {
    const result = await db.query("SELECT * FROM uzivatele WHERE email = $1", [
      email,
    ]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const storedHashedPassword = user.heslo;
      bcrypt.compare(heslo, storedHashedPassword, (err, result) => {
        if (err) {
          return cb(err);
        } else {
          if (result) {
            return cb(null, user)
          } else {
            //nespravne heslo - neni to primo error ale lidska chyba
            //proto namisto user je zde false - uzivatel neni autentifikovan
            return cb(null, false)
          }
        }
      });
    } else {
      //toto je error
      return cb("User not found.")
    }
  } catch (err) {
    return cb(err);
  }

}));

//serializace uzivatele - ulozeni dat do local storage
passport.serializeUser((user, cb) => {
  //cb navrati detaily o uzivateli
  cb(null, user);
});

//deserializuje info uzivatele, abychom ho mohli cist
passport.deserializeUser((user, cb) => {
  //cb navrati detaily o uzivateli
  cb(null, user);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
}); 

