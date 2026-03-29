const express = require('express');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());

// Initialisation de la base de données SQLite en mémoire (disparaît à l'arrêt du serveur)
const db = new Database(':memory:');

// ==========================================
// 1. INITIALISATION DE LA BDD & JEU D'ESSAI
// ==========================================
db.exec(`
    CREATE TABLE CLIENT (
        id_client INTEGER PRIMARY KEY, code_client TEXT, nom_societe TEXT
    );
    CREATE TABLE CATEGORIE_TVA (
        id_categorie_tva INTEGER PRIMARY KEY, nom_categorie TEXT
    );
    CREATE TABLE HISTORIQUE_TAUX_TVA (
        id_historique_tva INTEGER PRIMARY KEY, id_categorie_tva INTEGER, 
        taux REAL, date_debut_validite TEXT, date_fin_validite TEXT
    );
    CREATE TABLE PRODUIT_CATALOGUE (
        id_produit INTEGER PRIMARY KEY, id_categorie_tva INTEGER, 
        designation_courante TEXT, prix_unitaire_ht_courant REAL
    );
    CREATE TABLE FACTURE (
        id_facture INTEGER PRIMARY KEY AUTOINCREMENT, id_client INTEGER, 
        reference_facture TEXT, date_facturation TEXT
    );
    CREATE TABLE LIGNE_FACTURE (
        id_ligne INTEGER PRIMARY KEY AUTOINCREMENT, id_facture INTEGER, id_produit INTEGER, 
        designation_historique TEXT, prix_unitaire_ht_historique REAL, 
        taux_tva_applique REAL, quantite INTEGER
    );
`);

// Insertion des données tirées de l'énoncé Okayo
db.prepare("INSERT INTO CLIENT (id_client, code_client, nom_societe) VALUES (1, 'CU2203-0005', 'Mon client SAS')").run();

db.prepare("INSERT INTO CATEGORIE_TVA (id_categorie_tva, nom_categorie) VALUES (1, 'Taux Normal'), (2, 'Taux Intermédiaire'), (3, 'Taux Réduit')").run();

// Historique des TVA (ex: Taux Normal à 20%, Intermédiaire à 7%, Réduit à 5.5%)
db.prepare("INSERT INTO HISTORIQUE_TAUX_TVA (id_categorie_tva, taux, date_debut_validite) VALUES (1, 20.0, '2010-01-01')").run();
db.prepare("INSERT INTO HISTORIQUE_TAUX_TVA (id_categorie_tva, taux, date_debut_validite) VALUES (2, 7.0, '2010-01-01')").run();
db.prepare("INSERT INTO HISTORIQUE_TAUX_TVA (id_categorie_tva, taux, date_debut_validite) VALUES (3, 5.5, '2010-01-01')").run();

// Catalogue de produits
const insertProduit = db.prepare("INSERT INTO PRODUIT_CATALOGUE (id_produit, id_categorie_tva, designation_courante, prix_unitaire_ht_courant) VALUES (?, ?, ?, ?)");
insertProduit.run(1, 1, 'Mon produit C', 70000.00);
insertProduit.run(2, 3, 'Mon produit A', 1500.00);
insertProduit.run(3, 1, 'Mon produit D', 3000.00);
insertProduit.run(4, 2, 'Mon produit B', 4000.00);


// ==========================================
// 2. ROUTES DE L'API
// ==========================================

// GET /api/products : Récupérer le catalogue
app.get('/api/products', (req, res) => {
    const products = db.prepare(`
        SELECT p.id_produit, p.designation_courante, p.prix_unitaire_ht_courant, c.nom_categorie
        FROM PRODUIT_CATALOGUE p
        JOIN CATEGORIE_TVA c ON p.id_categorie_tva = c.id_categorie_tva
    `).all();
    res.json(products);
});

// POST /api/invoices : Créer une facture (Logique d'immutabilité)
app.post('/api/invoices', (req, res) => {
    const { id_client, reference_facture, date_facturation, lignes } = req.body;

    // Début de la transaction (pour s'assurer que tout s'enregistre ou rien du tout)
    const createInvoice = db.transaction(() => {
        // 1. Création de l'entête de la facture
        const infoFacture = db.prepare(
            "INSERT INTO FACTURE (id_client, reference_facture, date_facturation) VALUES (?, ?, ?)"
        ).run(id_client, reference_facture, date_facturation);

        const id_facture = infoFacture.lastInsertRowid;

        // 2. Traitement des lignes de la facture
        const insertLigne = db.prepare(`
            INSERT INTO LIGNE_FACTURE (id_facture, id_produit, designation_historique, prix_unitaire_ht_historique, taux_tva_applique, quantite)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        for (const ligne of lignes) {
            // Récupérer les infos du produit au moment présent
            const produit = db.prepare("SELECT * FROM PRODUIT_CATALOGUE WHERE id_produit = ?").get(ligne.id_produit);

            // Récupérer le taux de TVA en vigueur à la date de facturation
            // (Ici on prend le taux dont la date de début est passée, et qui n'a pas de date de fin ou une date de fin future)
            const tva = db.prepare(`
                SELECT taux FROM HISTORIQUE_TAUX_TVA 
                WHERE id_categorie_tva = ? 
                AND date_debut_validite <= ? 
                AND (date_fin_validite IS NULL OR date_fin_validite > ?)
                ORDER BY date_debut_validite DESC LIMIT 1
            `).get(produit.id_categorie_tva, date_facturation, date_facturation);

            // INSÉRER EN DUR (Immutabilité de la facture)
            insertLigne.run(
                id_facture,
                produit.id_produit,
                produit.designation_courante, // Nom figé
                produit.prix_unitaire_ht_courant, // Prix figé
                tva.taux, // Taux figé
                ligne.quantite
            );
        }
        return id_facture;
    });

    try {
        const newInvoiceId = createInvoice();
        res.status(201).json({ message: "Facture créée avec succès", id_facture: newInvoiceId });
    } catch (err) {
        res.status(500).json({ error: "Erreur lors de la création de la facture", details: err.message });
    }
});

// GET /api/invoices/:id : Consulter une facture et calculer ses totaux
app.get('/api/invoices/:id', (req, res) => {
    const id_facture = req.params.id;

    // 1. Récupérer l'entête
    const facture = db.prepare(`
        SELECT f.*, c.nom_societe, c.code_client 
        FROM FACTURE f 
        JOIN CLIENT c ON f.id_client = c.id_client 
        WHERE f.id_facture = ?
    `).get(id_facture);

    if (!facture) return res.status(404).json({ error: "Facture introuvable" });

    // 2. Récupérer les lignes (données historiques)
    const lignes = db.prepare("SELECT * FROM LIGNE_FACTURE WHERE id_facture = ?").all(id_facture);

    // 3. Calcul dynamique des totaux
    let totalHT = 0;
    let tvaParTaux = {}; // Pour regrouper les montants de TVA par pourcentage (ex: "Total TVA 20%")

    const lignesCalculees = lignes.map(ligne => {
        const totalLigneHT = ligne.prix_unitaire_ht_historique * ligne.quantite;
        const montantTvaLigne = totalLigneHT * (ligne.taux_tva_applique / 100);

        totalHT += totalLigneHT;

        // Regroupement de la TVA
        const keyTva = `Total TVA ${ligne.taux_tva_applique}%`;
        if (!tvaParTaux[keyTva]) tvaParTaux[keyTva] = 0;
        tvaParTaux[keyTva] += montantTvaLigne;

        return {
            designation: ligne.designation_historique,
            quantite: ligne.quantite,
            prix_unitaire_ht: ligne.prix_unitaire_ht_historique,
            taux_tva: ligne.taux_tva_applique,
            total_ligne_ht: totalLigneHT
        };
    });

    // Calcul du TTC final
    const totalTVA = Object.values(tvaParTaux).reduce((sum, val) => sum + val, 0);
    const totalTTC = totalHT + totalTVA;

    // 4. Construction de la réponse finale
    res.json({
        entete: facture,
        lignes: lignesCalculees,
        recapitulatif: {
            total_ht: totalHT,
            details_tva: tvaParTaux,
            total_ttc: totalTTC
        }
    });
});

// ==========================================
// 3. DÉMARRAGE DU SERVEUR
// ==========================================
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Serveur API Okayo démarré sur http://localhost:${PORT}`);
    console.log(`Testez le catalogue : GET http://localhost:${PORT}/api/products`);
});