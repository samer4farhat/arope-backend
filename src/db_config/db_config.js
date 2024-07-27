const mysql = require('mysql2');

const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'samer123',
    database: 'arope_db',
    timezone: 'Z'
})

module.exports = db;
