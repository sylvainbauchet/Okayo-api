const express = require('express');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// Initialisation de la base de données SQLite en mémoire
const db = new Database(':memory:');

// ==========================================
// 1. INITIALISATION DE LA BDD (Nouveau Schéma)
// ==========================================
db.exec(`
    CREATE TABLE CLIENT (
                            id_client INTEGER PRIMARY KEY,
                            code_client TEXT,
                            nom_societe TEXT
    );

    CREATE TABLE CATEGORIE_TVA (
                                   id_categorie_tva INTEGER PRIMARY KEY,
                                   nom_categorie TEXT,
                                   taux_actuel REAL
    );

    CREATE TABLE PRODUIT_CATALOGUE (
                                       id_produit INTEGER PRIMARY KEY,
                                       designation_courante TEXT,
                                       prix_unitaire_ht_courant REAL
    );

    CREATE TABLE FACTURE (
                             id_facture INTEGER PRIMARY KEY AUTOINCREMENT,
                             id_client INTEGER,
                             reference_facture TEXT,
                             date_facturation TEXT
    );

    CREATE TABLE LIGNE_FACTURE (
                                   id_ligne INTEGER PRIMARY KEY AUTOINCREMENT,
                                   id_facture INTEGER,
                                   id_produit INTEGER,
                                   id_categorie_tva INTEGER,
                                   quantite INTEGER DEFAULT 1,

        -- Champs historiques pour garantir l'immutabilité demandée par Okayo
                                   designation_historique TEXT,
                                   prix_unitaire_ht_historique REAL,
                                   taux_tva_historique REAL
    );
`);

// ==========================================
// 2. JEU D'ESSAI (Données d'exemple)
// ==========================================
db.prepare("INSERT INTO CLIENT (id_client, code_client, nom_societe) VALUES (1, 'CU2203-0005', 'Mon client SAS')").run();

// Les taux de TVA sont désormais simplifiés
db.prepare("INSERT INTO CATEGORIE_TVA (id_categorie_tva, nom_categorie, taux_actuel) VALUES (1, 'Taux Normal', 20.0), (2, 'Taux Intermédiaire', 7.0), (3, 'Taux Réduit', 5.5)").run();

// Le catalogue ne contient plus la TVA directement, on la liera à la ligne de facture
const insertProduit = db.prepare("INSERT INTO PRODUIT_CATALOGUE (id_produit, designation_courante, prix_unitaire_ht_courant) VALUES (?, ?, ?)");
insertProduit.run(1, 'Mon produit C', 70000.00);
insertProduit.run(2, 'Mon produit A', 1500.00);
insertProduit.run(3, 'Mon produit D', 3000.00);
insertProduit.run(4, 'Mon produit B', 4000.00);


// ==========================================
// 3. ROUTES DE L'API
// ==========================================

// GET /api/products : Récupérer le catalogue
app.get('/api/products', (req, res) => {
    const products = db.prepare("SELECT * FROM PRODUIT_CATALOGUE").all();
    res.json(products);
});

// POST /api/invoices : Créer une facture
app.post('/api/invoices', (req, res) => {
    const { id_client, reference_facture, date_facturation, lignes } = req.body;

    const createInvoice = db.transaction(() => {
        // 1. Création de l'entête
        const infoFacture = db.prepare(
            "INSERT INTO FACTURE (id_client, reference_facture, date_facturation) VALUES (?, ?, ?)"
        ).run(id_client, reference_facture, date_facturation);

        const id_facture = infoFacture.lastInsertRowid;

        // 2. Traitement des lignes (Regroupement Produit + TVA)
        const insertLigne = db.prepare(`
            INSERT INTO LIGNE_FACTURE (
                id_facture, id_produit, id_categorie_tva, quantite,
                designation_historique, prix_unitaire_ht_historique, taux_tva_historique
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const ligne of lignes) {
            // Lecture des données actuelles
            const produit = db.prepare("SELECT * FROM PRODUIT_CATALOGUE WHERE id_produit = ?").get(ligne.id_produit);
            const tva = db.prepare("SELECT * FROM CATEGORIE_TVA WHERE id_categorie_tva = ?").get(ligne.id_categorie_tva);

            // Copie en dur dans la ligne de facture pour l'immutabilité
            insertLigne.run(
                id_facture,
                produit.id_produit,
                tva.id_categorie_tva,
                ligne.quantite,
                produit.designation_courante,     // Fige le nom
                produit.prix_unitaire_ht_courant, // Fige le prix HT
                tva.taux_actuel                   // Fige le taux de TVA
            );
        }
        return id_facture;
    });

    try {
        const newInvoiceId = createInvoice();
        res.status(201).json({ message: "Facture créée avec succès", id_facture: newInvoiceId });
    } catch (err) {
        res.status(500).json({ error: "Erreur lors de la création", details: err.message });
    }
});

// GET /api/invoices/:id : Consulter une facture et calculer les totaux
app.get('/api/invoices/:id', (req, res) => {
    const id_facture = req.params.id;

    const facture = db.prepare(`
        SELECT f.*, c.nom_societe, c.code_client 
        FROM FACTURE f 
        JOIN CLIENT c ON f.id_client = c.id_client 
        WHERE f.id_facture = ?
    `).get(id_facture);

    if (!facture) return res.status(404).json({ error: "Facture introuvable" });

    // On récupère les lignes avec les données figées
    const lignes = db.prepare("SELECT * FROM LIGNE_FACTURE WHERE id_facture = ?").all(id_facture);

    let totalHT = 0;
    let tvaParTaux = {};

    const lignesCalculees = lignes.map(ligne => {
        // Le calcul se base strictement sur les champs "_historique"
        const totalLigneHT = ligne.prix_unitaire_ht_historique * ligne.quantite;
        const montantTvaLigne = totalLigneHT * (ligne.taux_tva_historique / 100);

        totalHT += totalLigneHT;

        const keyTva = `Total TVA ${ligne.taux_tva_historique}%`;
        if (!tvaParTaux[keyTva]) tvaParTaux[keyTva] = 0;
        tvaParTaux[keyTva] += montantTvaLigne;

        return {
            designation: ligne.designation_historique,
            quantite: ligne.quantite,
            prix_unitaire_ht: ligne.prix_unitaire_ht_historique,
            taux_tva: ligne.taux_tva_historique,
            total_ligne_ht: totalLigneHT
        };
    });

    const totalTVA = Object.values(tvaParTaux).reduce((sum, val) => sum + val, 0);
    const totalTTC = totalHT + totalTVA;

    res.json({
        entete: facture,
        lignes: lignesCalculees,
        recapitulatif: { total_ht: totalHT, details_tva: tvaParTaux, total_ttc: totalTTC }
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Serveur API Okayo démarré sur http://localhost:${PORT}`);
});