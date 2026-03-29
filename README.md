# Guide Rapide : Faire tourner l'API Okayo

Ce guide vous explique comment installer et lancer l'application de facturation sur votre ordinateur.

# 1. Installation

Assurez-vous d'avoir Node.js installé. Ouvrez votre terminal dans le dossier du projet et tapez :

## Initialiser le projet (si ce n'est pas déjà fait)
```sh
npm init -y
```


## Installer les deux outils nécessaires (Express et SQLite)
```shell
npm install express better-sqlite3
```


# 2. Lancement du serveur

Pour démarrer l'application, lancez la commande suivante :
```shell
node server.js
```



Le message Serveur API Okayo démarré... sur le port 3000 doit apparaître.
# 3. Comment tester (3 étapes simples)

Vous pouvez tester l'application directement via WebStorm (avec un fichier .http) ou avec les commandes suivantes :
Étape A : Créer un brouillon

On envoie les produits et les quantités.


## Commandes à copier dans un terminal :
```shell
curl -X POST http://localhost:3000/api/invoices -H "Content-Type: application/json" -d '{"id_client": 1, "lignes": [{"id_produit": 1, "quantite": 1}, {"id_produit": 2, "quantite": 2}]}'
```


Étape B : Valider la facture (Figeage)

Cette étape "bloque" les prix et la TVA pour qu'ils ne changent plus jamais.


## Remplacez "1" par l'ID reçu à l'étape A
```shell
curl -X POST http://localhost:3000/api/invoices/1/validate -H "Content-Type: application/json" -d '{"date_facturation": "2018-07-26"}'
```

Étape C : Voir le résultat final
```sh
curl http://localhost:3000/api/invoices/1
```