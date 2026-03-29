const express = require('express');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

const db = new Database(':memory:');

// ==========================================
// 1. INITIALISATION DE LA BDD (Schéma Avancé)
// ==========================================
db.exec(`
    CREATE TABLE CLIENT (id_client INTEGER PRIMARY KEY, code_client TEXT, nom_societe TEXT);
    
    CREATE TABLE CATEGORIE_TVA (id_categorie_tva INTEGER PRIMARY KEY, nom_categorie TEXT);
    CREATE TABLE HISTORIQUE_TAUX_TVA (
        id_historique_tva INTEGER PRIMARY KEY, id_categorie_tva INTEGER, 
        taux REAL, date_debut_validite TEXT, date_fin_validite TEXT
    );
    
    CREATE TABLE PRODUIT_CATALOGUE (
        id_produit INTEGER PRIMARY KEY, id_categorie_tva INTEGER, designation_actuelle TEXT
    );
    CREATE TABLE HISTORIQUE_PRIX_PRODUIT (
        id_historique_prix INTEGER PRIMARY KEY, id_produit INTEGER, 
        prix_unitaire_ht REAL, date_debut_validite TEXT, date_fin_validite TEXT
    );

    CREATE TABLE FACTURE (
        id_facture INTEGER PRIMARY KEY AUTOINCREMENT, 
        id_client INTEGER, reference_facture TEXT, 
        date_creation TEXT, date_facturation TEXT, 
        statut TEXT DEFAULT 'BROUILLON'
    );

    CREATE TABLE LIGNE_FACTURE (
        id_ligne INTEGER PRIMARY KEY AUTOINCREMENT, 
        id_facture INTEGER, id_produit INTEGER, quantite INTEGER DEFAULT 1,
        designation_figee TEXT, prix_unitaire_ht_fige REAL, taux_tva_fige REAL
    );
`);

// --- JEU D'ESSAI ---
db.prepare("INSERT INTO CLIENT (id_client, code_client, nom_societe) VALUES (1, 'CU2203-0005', 'Mon client SAS')").run();

// Catégories et Historique TVA (Actuels, donc date_fin_validite est NULL)
db.prepare("INSERT INTO CATEGORIE_TVA (id_categorie_tva, nom_categorie) VALUES (1, 'Taux Normal'), (2, 'Taux Intermédiaire'), (3, 'Taux Réduit')").run();
db.prepare("INSERT INTO HISTORIQUE_TAUX_TVA (id_categorie_tva, taux, date_debut_validite) VALUES (1, 20.0, '2018-01-01'), (2, 7.0, '2018-01-01'), (3, 5.5, '2018-01-01')").run();

// Produits et Historique Prix
const insertProd = db.prepare("INSERT INTO PRODUIT_CATALOGUE (id_produit, id_categorie_tva, designation_actuelle) VALUES (?, ?, ?)");
const insertPrix = db.prepare("INSERT INTO HISTORIQUE_PRIX_PRODUIT (id_produit, prix_unitaire_ht, date_debut_validite) VALUES (?, ?, '2018-01-01')");

insertProd.run(1, 1, 'Mon produit C'); insertPrix.run(1, 70000.00);
insertProd.run(2, 3, 'Mon produit A'); insertPrix.run(2, 1500.00);
insertProd.run(3, 1, 'Mon produit D'); insertPrix.run(3, 3000.00);
insertProd.run(4, 2, 'Mon produit B'); insertPrix.run(4, 4000.00);

// ==========================================
// 2. ROUTES DE L'API
// ==========================================

// 1. Créer une facture BROUILLON
app.post('/api/invoices', (req, res) => {
    const { id_client, lignes } = req.body;
    const date_creation = new Date().toISOString().split('T')[0];

    const createDraft = db.transaction(() => {
        const info = db.prepare("INSERT INTO FACTURE (id_client, date_creation, statut) VALUES (?, ?, 'BROUILLON')").run(id_client, date_creation);
        const id_facture = info.lastInsertRowid;

        const insertLigne = db.prepare("INSERT INTO LIGNE_FACTURE (id_facture, id_produit, quantite) VALUES (?, ?, ?)");
        for (const ligne of lignes) {
            insertLigne.run(id_facture, ligne.id_produit, ligne.quantite); // On ne fige rien à cette étape !
        }
        return id_facture;
    });

    res.status(201).json({ message: "Brouillon créé", id_facture: createDraft() });
});

// 2. VALIDER la facture (C'est ici qu'on rend la facture immuable)
app.post('/api/invoices/:id/validate', (req, res) => {
    const id_facture = req.params.id;
    const date_facturation = req.body.date_facturation || new Date().toISOString().split('T')[0];

    const facture = db.prepare("SELECT * FROM FACTURE WHERE id_facture = ?").get(id_facture);
    if (!facture) return res.status(404).json({ error: "Facture introuvable" });
    if (facture.statut === 'VALIDEE') return res.status(400).json({ error: "Facture déjà validée et immuable" });

    const validateInvoice = db.transaction(() => {
        // A. Générer la référence et passer en statut VALIDEE
        const reference = `2022-00${id_facture + 24}`; // Simulation d'une ref (ex: 2022-0025)
        db.prepare("UPDATE FACTURE SET statut = 'VALIDEE', date_facturation = ?, reference_facture = ? WHERE id_facture = ?").run(date_facturation, reference, id_facture);

        // B. Figer les lignes en cherchant dans l'historique à la date de facturation
        const lignes = db.prepare("SELECT * FROM LIGNE_FACTURE WHERE id_facture = ?").all(id_facture);
        const updateLigne = db.prepare("UPDATE LIGNE_FACTURE SET designation_figee = ?, prix_unitaire_ht_fige = ?, taux_tva_fige = ? WHERE id_ligne = ?");

        for (const ligne of lignes) {
            const produit = db.prepare("SELECT * FROM PRODUIT_CATALOGUE WHERE id_produit = ?").get(ligne.id_produit);

            // Cherche le prix valide à la date
            const prix = db.prepare(`SELECT prix_unitaire_ht FROM HISTORIQUE_PRIX_PRODUIT WHERE id_produit = ? AND date_debut_validite <= ? AND (date_fin_validite IS NULL OR date_fin_validite > ?) ORDER BY date_debut_validite DESC LIMIT 1`).get(produit.id_produit, date_facturation, date_facturation);

            // Cherche la TVA valide à la date
            const tva = db.prepare(`SELECT taux FROM HISTORIQUE_TAUX_TVA WHERE id_categorie_tva = ? AND date_debut_validite <= ? AND (date_fin_validite IS NULL OR date_fin_validite > ?) ORDER BY date_debut_validite DESC LIMIT 1`).get(produit.id_categorie_tva, date_facturation, date_facturation);

            // COPIE EN DUR (IMMUTABILITÉ)
            updateLigne.run(produit.designation_actuelle, prix.prix_unitaire_ht, tva.taux, ligne.id_ligne);
        }
    });

    validateInvoice();
    res.json({ message: "Facture validée et figée définitivement." });
});

// 3. Consulter la facture
app.get('/api/invoices/:id', (req, res) => {
    const id_facture = req.params.id;
    const date_consultation = new Date().toISOString().split('T')[0];

    const facture = db.prepare("SELECT f.*, c.nom_societe, c.code_client FROM FACTURE f JOIN CLIENT c ON f.id_client = c.id_client WHERE f.id_facture = ?").get(id_facture);
    if (!facture) return res.status(404).json({ error: "Introuvable" });

    const lignes = db.prepare("SELECT * FROM LIGNE_FACTURE WHERE id_facture = ?").all(id_facture);

    let totalHT = 0; let tvaParTaux = {};

    const lignesCalculees = lignes.map(ligne => {
        let designation, prix_ht, taux_tva;

        if (facture.statut === 'VALIDEE') {
            // Lecture des données figées (Sécurité absolue)
            designation = ligne.designation_figee;
            prix_ht = ligne.prix_unitaire_ht_fige;
            taux_tva = ligne.taux_tva_fige;
        } else {
            // Mode Brouillon : Prévisualisation avec les tarifs en temps réel
            const p = db.prepare("SELECT * FROM PRODUIT_CATALOGUE WHERE id_produit = ?").get(ligne.id_produit);
            const prix = db.prepare("SELECT prix_unitaire_ht FROM HISTORIQUE_PRIX_PRODUIT WHERE id_produit = ? ORDER BY date_debut_validite DESC LIMIT 1").get(ligne.id_produit);
            const tva = db.prepare("SELECT taux FROM HISTORIQUE_TAUX_TVA WHERE id_categorie_tva = ? ORDER BY date_debut_validite DESC LIMIT 1").get(p.id_categorie_tva);

            designation = p.designation_actuelle + " (Prévisualisation)";
            prix_ht = prix.prix_unitaire_ht;
            taux_tva = tva.taux;
        }

        const totalLigneHT = prix_ht * ligne.quantite;
        totalHT += totalLigneHT;

        const keyTva = `Total TVA ${taux_tva}%`;
        if (!tvaParTaux[keyTva]) tvaParTaux[keyTva] = 0;
        tvaParTaux[keyTva] += totalLigneHT * (taux_tva / 100);

        return { designation, quantite: ligne.quantite, prix_unitaire_ht: prix_ht, taux_tva, total_ligne_ht: totalLigneHT };
    });

    const totalTVA = Object.values(tvaParTaux).reduce((sum, val) => sum + val, 0);

    res.json({
        entete: facture, lignes: lignesCalculees,
        recapitulatif: { total_ht: totalHT, details_tva: tvaParTaux, total_ttc: totalHT + totalTVA }
    });
});

app.listen(3000, () => console.log(`Serveur API Okayo démarré (Mode Brouillon/Validation) sur le port 3000`));