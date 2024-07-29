const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./src/db_config/db_config.js');
var cors = require('cors');
const cron = require('node-cron');
const moment = require('moment');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = 5000;

const jwt_secret = 'b01abafb275676041ad5c77c7117e31b165a2fd410b938c80a64c190fee0ff6e55791a4ae0eedd9e89b62b66ef1779f61e8086f09719d243d3c3fbfef4c77d23';

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

function camelToSnake(obj) {
    let newObj = {};
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
            let newKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
            newObj[newKey] = obj[key];
        }
    }
    return newObj;
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
  
    if (token == null) return res.sendStatus(401)
  
    jwt.verify(token, jwt_secret, (err, user_details) => {
      console.log(err)
  
      if (err) return res.sendStatus(403)
  
      req.user = user_details
  
      next()
    })
}




function getIdFromToken(req) {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    var id = '';
  
    if (token == null) return res.sendStatus(401)
  
    jwt.verify(token, jwt_secret, (err, user_details) => {
  
      if (err) return res.sendStatus(403)

      id = user_details.id

    })

    return id;
}

function hrAuthenticateToken(req, res, next) {
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
  
    if (token == null) return res.sendStatus(401)
  
    jwt.verify(token, jwt_secret, (err, user_details) => {
      console.log(err)
  
      if (err || !user_details.is_hr) return res.sendStatus(403)

      req.user = user_details
  
      next()
    })
}

app.get('/initial/login/:email', (req, res) => {
    const email = req.params.email;
    var query = `
        SELECT 
        (EXISTS (
            SELECT 1 
            FROM employee 
            WHERE email = ?
        )) AS email_exists,
        (EXISTS (
            SELECT 1 
            FROM employee 
            WHERE email = ?
            AND password IS NULL
        )) AS password_is_null;
    `;
    db.query(query, [email, email], (err, result) => {
        if (err) res.send(err);
        else res.send(result[0]);
    })
});

app.get('/employee', hrAuthenticateToken, (req, res) => {
    var query = `
        SELECT e.id, e.first_name, e.middle_name, e.last_name, e.email, e.days, d.name AS "department_name", e.manager_id, me.first_name AS "manager_first_name", me.last_name AS "manager_last_name" 
        FROM employee e
        LEFT JOIN department d
        ON e.department_id = d.id
        LEFT JOIN employee me
        ON e.manager_id = me.id;
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});

app.get('/employee/:id', (req, res) => {
    const id = req.params.id;
    var query = `
        SELECT e.id, e.first_name, e.middle_name, e.last_name, e.email, e.days, d.id AS "department_id", d.name AS "department_name", e.manager_id, me.first_name AS "manager_first_name", me.last_name AS "manager_last_name"
        FROM employee e
        LEFT JOIN department d
        ON e.department_id = d.id
        LEFT JOIN employee me
        ON e.manager_id = me.id
        WHERE e.id = ${id};
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result[0]);
    });
});

app.post('/employee', hrAuthenticateToken, async (req, res) => {
    const { firstName, middleName, lastName, departmentId, managerId, birthday } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token
    const email = firstName.toLowerCase()[0] + lastName.toLowerCase() + "@arope.com";
    
    const query = `
        INSERT INTO employee 
        (first_name, middle_name, last_name, email, department_id, manager_id, birthday) 
        VALUES (?,?,?,?,?,?,?);
    `;
    db.query(query, [firstName, middleName, lastName, email, departmentId, managerId, birthday], (err, result) => {
        if (err) {
            res.send(err);
        } else {
            addLog(hrUserId, 'Add Employee', `Added employee: ${firstName} ${middleName} ${lastName}`);
            res.send(result);
        }
    });
});

app.patch('/employee/:id', hrAuthenticateToken, (req, res) => {
    const id = req.params.id;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token

    db.query(`SELECT * FROM employee WHERE id = ?`, [id], (err, result) => {
        if (err) {
            res.send(err);
        } else {
            const originalEmployee = result[0];
            const updatedEmployee = { ...originalEmployee, ...camelToSnake(req.body) };
            const { first_name, middle_name, last_name, email, department_id, manager_id } = updatedEmployee;
            const query = `
                UPDATE employee
                SET first_name = ?, middle_name = ?, last_name = ?, email = ?, department_id = ?, manager_id = ? 
                WHERE id = ?;
            `;
            db.query(query, [first_name, middle_name, last_name, email, department_id, manager_id, id], (err, result) => {
                if (err) {
                    res.send(err);
                } else {
                    const changes = Object.keys(updatedEmployee)
                        .filter(key => updatedEmployee[key] !== originalEmployee[key])
                        .map(key => `${key}: ${originalEmployee[key]} => ${updatedEmployee[key]}`)
                        .join(', ');

                    addLog(hrUserId, 'Edit Employee', `Edited employee: ${first_name} ${last_name}, changes: ${changes}`);
                    res.send(result);
                }
            });
        }
    });
});



app.delete('/employee/:id', async (req, res) => {
    const id = req.params.id;
    var query = `
        DELETE FROM employee 
        WHERE id = ${id};
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});


app.post('/login', async (req, res) => {
    const { email, password, isInitialLogin } = req.body;

    const query = `
        SELECT e.*, d.manager_id AS department_manager_id 
        FROM employee e 
        LEFT JOIN department d ON e.department_id = d.id 
        WHERE e.email = ?
    `;
    db.query(query, [email], async (err, result) => {
        if (err) {
            res.status(500).send(err);
        } else if (result.length === 0) {
            res.status(401).send({ message: 'Invalid email' });
        } else {
            const user = result[0];

            const isManager = user.manager_id === null || user.department_manager_id === user.id;

            if (isInitialLogin) {
                const hashedPassword = await bcrypt.hash(password, bcrypt.genSaltSync(12));
                db.query('UPDATE employee SET password = ? WHERE id = ?', [hashedPassword, user.id], (err, result) => {
                    if (err) res.send(err);
                });
                const token = jwt.sign({ id: user.id, is_hr: user.department_id == 4, is_manager: isManager }, jwt_secret, { expiresIn: '1h' });
                res.send({ 
                    message: 'Login successful', 
                    token, 
                    firstName: user.first_name, 
                    lastName: user.last_name, 
                    department: user.department_id,
                    isHr: user.department_id == 4,
                    isManager: isManager 
                });
            } else {
                const isMatch = await bcrypt.compare(password, user.password);
                if (isMatch) {
                    const token = jwt.sign({ id: user.id, is_hr: user.department_id == 4, is_manager: isManager }, jwt_secret, { expiresIn: '1h' });
                    res.send({ 
                        message: 'Login successful', 
                        token, 
                        firstName: user.first_name, 
                        lastName: user.last_name, 
                        department: user.department_id,
                        isHr: user.department_id == 4,
                        isManager: isManager 
                    });
                } else {
                    res.status(401).send({ message: 'Invalid email or password' });
                }
            }
        }
    });
});

app.get('/departments', (req, res) => {
    var query = `
        SELECT *
        FROM department d
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result);
})});

app.post('/departments', hrAuthenticateToken, async (req, res) => {
    const { name } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token

    const query = `
        INSERT INTO department (name)
        VALUES (?);
    `;
    db.query(query, [name], (err, result) => {
        if (err) {
            res.send(err);
        } else {
            const newDepartmentId = result.insertId;
            db.query(`SELECT * FROM department WHERE id = ?`, [newDepartmentId], (err, newDeptResult) => {
                if (err) {
                    res.send(err);
                } else {
                    addLog(hrUserId, 'Add Department', `Added department: ${name}`);
                    res.send(newDeptResult[0]);
                }
            });
        }
    });
});

app.patch('/departments/:id', hrAuthenticateToken, (req, res) => {
    const id = req.params.id;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token

    db.query(`SELECT * FROM department WHERE id = ?`, [id], (err, result) => {
        if (err) {
            res.send(err);
        } else {
            const originalDepartment = result[0];
            const query = `
                UPDATE department
                SET name = ?
                WHERE id = ?;
            `;
            db.query(query, [req.body.name, id], (err, result) => {
                if (err) {
                    res.send(err);
                } else {
                    addLog(hrUserId, 'Edit Department', `Edited department: ${originalDepartment.name} -> ${req.body.name}`);
                    res.send(result);
                }
            });
        }
    });
});

app.get('/managers/:department', (req, res) => {
    const token = req.headers['authorization'];
    const user_id = jwt.decode(token.split(' ')[1]).id;
    const department = req.params.department;

    var query = `
        SELECT e.id,e.first_name,e.last_name
        FROM employee e
        WHERE department_id = ?
        AND id != ?
    `;
    db.query(query, [department, user_id], (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    })
});

app.get('/manager/:departmentId', authenticateToken, async (req, res) => {
    const { departmentId } = req.params;
    try {
        const query = `
            SELECT e.id, e.first_name, e.last_name FROM employee e
            LEFT JOIN department d
            ON e.id = d.manager_id
            WHERE d.id = ?
        `;
        db.query(query, [departmentId], (err, result) => {
            if (err) res.send(err);
            else res.send(result[0]);
        })
    } catch (error) {
        console.error('Error fetching managers:', error);  // Log detailed error
        res.status(500).json({ message: 'Internal Server Error', error: error.message });  // Return detailed error
    }
});

// app.post('/leave-requests', authenticateToken, (req, res) => {
//     const { employeeId, typeOfLeave, quantity, leaveDetails } = req.body;
//     console.log('Received leave request:', req.body);

//     if (typeOfLeave === 'Sick Leave Without Note') {
//         const checkSickLeaveQuery = `
//             SELECT SUM(quantity) as total
//             FROM leave_requests
//             WHERE employee_id = ? AND type_of_leave = 'Sick Leave Without Note' AND request_status != 'Cancelled'
//         `;

//         db.query(checkSickLeaveQuery, [employeeId], (err, results) => {
//             if (err) {
//                 console.error('Database query error:', err);
//                 return res.status(500).send(err);
//             }

//             const totalDaysWithoutNote = parseFloat(results[0].total) || 0;
//             const requestQuantity = parseFloat(quantity);
//             const totalRequested = totalDaysWithoutNote + requestQuantity;
            
//             console.log("Total days without note:", totalDaysWithoutNote);
//             console.log("Requested quantity:", requestQuantity);
//             console.log("Total requested days:", totalRequested);
            
//             if (totalRequested > 2) {
//                 return res.status(400).send({ message: 'You cannot request more than 2 sick leave days without a note.' });
//             }

//             insertLeaveRequest();
//         });
//     } else {
//         insertLeaveRequest();
//     }

//     function insertLeaveRequest() {
//         const query = `
//             INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
//             VALUES (?, ?, ?, ?, ?, ?, NOW())
//         `;

//         const startDate = leaveDetails[0].date;
//         const endDate = leaveDetails[leaveDetails.length - 1].date;

//         db.query(query, [employeeId, typeOfLeave, "Pending Manager", quantity, startDate, endDate], (err, result) => {
//             if (err) {
//                 console.error('Error adding leave request:', err);
//                 return res.status(500).send(err);
//             } 

//             const leaveRequestId = result.insertId;
//             const dateQueries = leaveDetails.map(detail => (
//                 new Promise((resolve, reject) => {
//                     const dateQuery = `
//                         INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, time)
//                         VALUES (?, ?, ?, ?)
//                     `;
//                     db.query(dateQuery, [leaveRequestId, detail.date, detail.duration, detail.time], (err, dateResult) => {
//                         if (err) reject(err);
//                         else resolve(dateResult);
//                     });
//                 })
//             ));

//             Promise.all(dateQueries)
//                 .then(() => {
//                     res.send({ message: 'Leave request added successfully' });
//                 })
//                 .catch(err => {
//                     console.error('Error adding leave request dates:', err);
//                     res.status(500).send(err);
//                 });
//         });
//     }
// });
// app.post('/leave-requests', authenticateToken, (req, res) => {
//     const { employeeId, typeOfLeave, quantity, leaveDetails } = req.body;
//     console.log('Received leave request:', req.body);

//     if (typeOfLeave === 'Sick Leave Without Note') {
//         const checkSickLeaveQuery = `
//             SELECT SUM(quantity) as total
//             FROM leave_requests
//             WHERE employee_id = ? AND type_of_leave = 'Sick Leave Without Note' AND request_status != 'Cancelled'
//         `;

//         db.query(checkSickLeaveQuery, [employeeId], (err, results) => {
//             if (err) {
//                 console.error('Database query error:', err);
//                 return res.status(500).send(err);
//             }

//             const totalDaysWithoutNote = parseFloat(results[0].total) || 0;
//             const requestQuantity = parseFloat(quantity);
//             const totalRequested = totalDaysWithoutNote + requestQuantity;

//             console.log("Total days without note:", totalDaysWithoutNote);
//             console.log("Requested quantity:", requestQuantity);
//             console.log("Total requested days:", totalRequested);

//             if (totalRequested > 2) {
//                 return res.status(400).send({ message: 'You cannot request more than 2 sick leave days without a note.' });
//             }

//             insertLeaveRequest();
//         });
//     } else {
//         insertLeaveRequest();
//     }

//     function insertLeaveRequest() {
//         const query = `
//             INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
//             VALUES (?, ?, ?, ?, ?, ?, NOW())
//         `;

//         const startDate = leaveDetails[0].date;
//         const endDate = leaveDetails[leaveDetails.length - 1].date;

//         db.query(query, [employeeId, typeOfLeave, "Pending Manager", quantity, startDate, endDate], (err, result) => {
//             if (err) {
//                 console.error('Error adding leave request:', err);
//                 return res.status(500).send(err);
//             }

//             const leaveRequestId = result.insertId;
//             const dateQueries = leaveDetails.map(detail => (
//                 new Promise((resolve, reject) => {
//                     const dateQuery = `
//                         INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, start_time, end_time)
//                         VALUES (?, ?, ?, ?, ?)
//                     `;
//                     db.query(dateQuery, [leaveRequestId, detail.date, detail.duration || null, detail.start_time, detail.end_time], (err, dateResult) => {
//                         if (err) reject(err);
//                         else resolve(dateResult);
//                     });
//                 })
//             ));

//             Promise.all(dateQueries)
//                 .then(() => {
//                     res.send({ message: 'Leave request added successfully' });
//                 })
//                 .catch(err => {
//                     console.error('Error adding leave request dates:', err);
//                     res.status(500).send(err);
//                 });
//         });
//     }
// });


app.post('/leave-requests', authenticateToken, (req, res) => {
    const { employeeId, typeOfLeave, quantity, leaveDetails } = req.body;
    console.log('Received leave request:', req.body);

    if (typeOfLeave === 'Sick Leave Without Note') {
        const checkSickLeaveQuery = `
            SELECT SUM(quantity) as total
            FROM leave_requests
            WHERE employee_id = ? AND type_of_leave = 'Sick Leave Without Note' AND request_status != 'Cancelled'
        `;

        db.query(checkSickLeaveQuery, [employeeId], (err, results) => {
            if (err) {
                console.error('Database query error:', err);
                return res.status(500).send(err);
            }

            const totalDaysWithoutNote = parseFloat(results[0].total) || 0;
            const requestQuantity = parseFloat(quantity);
            const totalRequested = totalDaysWithoutNote + requestQuantity;

            console.log("Total days without note:", totalDaysWithoutNote);
            console.log("Requested quantity:", requestQuantity);
            console.log("Total requested days:", totalRequested);

            if (totalRequested > 2) {
                return res.status(400).send({ message: 'You cannot request more than 2 sick leave days without a note.' });
            }

            insertLeaveRequest();
        });
    } else {
        insertLeaveRequest();
    }

    function insertLeaveRequest() {
        const query = `
            INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `;

        const startDate = leaveDetails[0].date;
        const endDate = leaveDetails[leaveDetails.length - 1].date;

        db.query(query, [employeeId, typeOfLeave, "Pending Manager", quantity, startDate, endDate], (err, result) => {
            if (err) {
                console.error('Error adding leave request:', err);
                return res.status(500).send(err);
            }

            const leaveRequestId = result.insertId;
            const dateQueries = leaveDetails.map(detail => (
                new Promise((resolve, reject) => {
                    const dateQuery = `
                        INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, start_time, end_time, time)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `;
                    const time = detail.duration === '0.5' ? detail.time : null;
                    db.query(dateQuery, [leaveRequestId, detail.date, detail.duration || null, detail.start_time, detail.end_time, time], (err, dateResult) => {
                        if (err) reject(err);
                        else resolve(dateResult);
                    });
                })
            ));

            Promise.all(dateQueries)
                .then(() => {
                    res.send({ message: 'Leave request added successfully' });
                })
                .catch(err => {
                    console.error('Error adding leave request dates:', err);
                    res.status(500).send(err);
                });
        });
    }
});












const addLog = (hrUser, action, details) => {
    const query = `
        INSERT INTO Logs (hr_user, action, details)
        VALUES (?, ?, ?)
    `;
    db.query(query, [hrUser, action, details], (err, result) => {
        if (err) console.error('Error logging action:', err);
    });
};

app.get('/logs', (req, res) => {
    const query = `
        SELECT l.id, e.first_name as "hr_user_first_name", e.last_name as "hr_user_last_name", l.action, l.details, l.timestamp
        FROM Logs l
        INNER JOIN employee e
        ON l.hr_user = e.id
        ORDER BY timestamp DESC
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});
// app.get('/manager-leave-requests', authenticateToken, (req, res) => {
//     const userId = req.user.id;

//     const query = `
//         SELECT 
//             lr.id,
//             lr.employee_id AS employeeId, 
//             CONCAT(e.first_name, ' ', e.last_name) AS name,
//             lr.type_of_leave AS typeOfLeave, 
//             lr.request_status AS requestStatus, 
//             SUM(ld.duration) AS quantity,
//             GROUP_CONCAT(ld.leave_date) AS dates,
//             lr.last_modified AS lastModified 
//         FROM leave_requests lr
//         JOIN employee e ON lr.employee_id = e.id
//         LEFT JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
//         WHERE e.manager_id = ? OR e.id IN (
//             SELECT id FROM employee WHERE department_id = (
//                 SELECT department_id FROM employee WHERE id = ?
//             )
//         )
//         GROUP BY lr.id
//         ORDER BY lastModified DESC
//     `;
//     db.query(query, [userId, userId], (err, result) => {
//         if (err) res.send(err);
//         else res.send(result);
//     });
// });
app.get('/manager-leave-requests', authenticateToken, (req, res) => {
    const userId = req.user.id;

    const query = `
        SELECT 
            lr.id,
            lr.employee_id AS employeeId, 
            CONCAT(e.first_name, ' ', e.last_name) AS name,
            lr.type_of_leave AS typeOfLeave, 
            lr.request_status AS requestStatus, 
            SUM(ld.duration) AS quantity,
            GROUP_CONCAT(ld.leave_date) AS dates,
            GROUP_CONCAT(
                CASE 
                    WHEN lr.type_of_leave = 'Personal Time Off' THEN CONCAT(DATE_FORMAT(ld.start_time, '%H:%i'), ' >> ',DATE_FORMAT(ld.end_time, '%H:%i'))
                    WHEN ld.duration = 0.5 THEN ld.time
                    ELSE ''
                END
            ) AS time,
            lr.last_modified AS lastModified 
        FROM leave_requests lr
        JOIN employee e ON lr.employee_id = e.id
        LEFT JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        WHERE e.manager_id = ? OR e.id IN (
            SELECT id FROM employee WHERE department_id = (
                SELECT department_id FROM employee WHERE id = ?
            )
        )
        GROUP BY lr.id
        ORDER BY lastModified DESC
    `;
    db.query(query, [userId, userId], (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});



app.post('/leave-requests/hr', authenticateToken, (req, res) => {
    const { employeeId, action, reason, leaveDetails } = req.body;

    let totalAmount = 0;
    leaveDetails.forEach(detail => {
        const { duration } = detail;
        totalAmount += Number(duration);
    });

    const typeOfLeave = reason;
    const requestStatus = action === 'Add' ? 'HR Add' : 'HR Remove';

    const startDate = leaveDetails[0].date;
    const endDate = leaveDetails[leaveDetails.length - 1].date;

    const query = `
        INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
    `;

    db.query(query, [employeeId, typeOfLeave, requestStatus, totalAmount, startDate, endDate], (err, result) => {
        if (err) {
            console.error('Error adding leave request:', err);
            res.status(500).send(err);
        } else {
            const leaveRequestId = result.insertId;
            const dateQueries = leaveDetails.map(detail => (
                new Promise((resolve, reject) => {
                    const dateQuery = `
                        INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, time)
                        VALUES (?, ?, ?, ?)
                    `;
                    db.query(dateQuery, [leaveRequestId, detail.date, detail.duration, detail.time], (err, dateResult) => {
                        if (err) reject(err);
                        else resolve(dateResult);
                    });
                })
            ));

            Promise.all(dateQueries)
                .then(() => {
                    const updateDaysQuery = action === 'Add'
                        ? 'UPDATE employee SET days = days + ? WHERE id = ?'
                        : 'UPDATE employee SET days = days - ? WHERE id = ?';

                    db.query(updateDaysQuery, [totalAmount, employeeId], (err, updateResult) => {
                        if (err) {
                            console.error('Error updating employee days:', err);
                            res.status(500).send(err);
                        } else {
                            res.send({ message: 'Leave request added successfully and days updated' });
                        }
                    });
                })
                .catch(err => {
                    console.error('Error adding leave request dates:', err);
                    res.status(500).send(err);
                });
        }
    });
});



// app.get('/leave-requests/:id', authenticateToken, (req, res) => {
//     const id = req.params.id;

//     const query = `
//         SELECT 
//             lr.id,
//             lr.employee_id AS employeeId, 
//             CONCAT(e.first_name, ' ', e.last_name) AS name,
//             lr.type_of_leave AS typeOfLeave, 
//             lr.request_status AS requestStatus, 
//             SUM(ld.duration) AS quantity,
//             GROUP_CONCAT(ld.leave_date) AS dates,
//             GROUP_CONCAT(
//                 CASE 
//                     WHEN ld.time = 'AM' THEN 'Morning'
//                     WHEN ld.time = 'PM' THEN 'Afternoon'
//                     ELSE 'N/A'
//                 END
//             ) AS time,
//             lr.last_modified AS lastModified
//         FROM leave_requests lr
//         JOIN employee e ON lr.employee_id = e.id
//         JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
//         WHERE lr.employee_id = ?
//         GROUP BY lr.id
//         ORDER BY lr.last_modified DESC
//     `;

//     db.query(query, [id], (err, result) => {
//         if (err) {
//             console.error('Error fetching leave requests and HR transactions:', err);
//             return res.status(500).send(err);
//         }
//         res.send(result);
//     });
// });
app.get('/leave-requests/:id', authenticateToken, (req, res) => {
    const id = req.params.id;
    console.log('Fetching leave requests for employee:', id);

    const query = `
        SELECT 
            lr.id,
            lr.employee_id AS employeeId, 
            CONCAT(e.first_name, ' ', e.last_name) AS name,
            lr.type_of_leave AS typeOfLeave, 
            lr.request_status AS requestStatus, 
            SUM(ld.duration) AS quantity,
            GROUP_CONCAT(ld.leave_date) AS dates,
            GROUP_CONCAT(
                CASE 
                    WHEN lr.type_of_leave = 'Personal Time Off' THEN CONCAT(DATE_FORMAT(ld.start_time, '%H:%i'), ' >> ',DATE_FORMAT(ld.end_time, '%H:%i'))
                    WHEN ld.duration = 0.5 THEN ld.time
                    ELSE 'N/A'
                END
            ) AS time,
            lr.last_modified AS lastModified
        FROM leave_requests lr
        JOIN employee e ON lr.employee_id = e.id
        LEFT JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        WHERE lr.employee_id = ?
        GROUP BY lr.id
        ORDER BY lr.last_modified DESC
    `;

    db.query(query, [id], (err, result) => {
        if (err) {
            console.error('Error fetching leave requests:', err);
            return res.status(500).send(err);
        }
        
        res.send(result);
    });
});




// app.get('/employee/:id/leave-summary', (req, res) => {
//     const employeeId = req.params.id;

//     const query = `
//         SELECT ld.leave_date AS date,
//                SUM(ld.duration) AS net_amount
//         FROM leave_requests lr
//         JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
//         WHERE lr.employee_id = ? 
//           AND (lr.request_status = 'Approved'
//           OR lr.request_status = 'HR Remove')
//         GROUP BY ld.leave_date
//         HAVING SUM(ld.duration) > 0
//         ORDER BY ld.leave_date;
//     `;

//     db.query(query, [employeeId], (err, results) => {
//         if (err) {
//             console.error('Database query error:', err);
//             res.status(500).send(err);
//         } else {
//             res.send(results);
//         }
//     });
// });
// app.get('/employee/:id/leave-summary', (req, res) => {
//     const employeeId = req.params.id;

//     const query = `
//         SELECT ld.leave_date AS date,
//                SUM(ld.duration) AS net_amount,
//                lr.type_of_leave AS leave_type
//         FROM leave_requests lr
//         JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
//         WHERE lr.employee_id = ? 
//           AND (lr.request_status = 'Approved'
//           OR lr.request_status = 'HR Remove')
//         GROUP BY ld.leave_date, lr.type_of_leave
//         HAVING SUM(ld.duration) > 0
//         ORDER BY ld.leave_date;
//     `;

//     db.query(query, [employeeId], (err, results) => {
//         if (err) {
//             console.error('Database query error:', err);
//             res.status(500).send(err);
//         } else {
//             res.send(results);
//         }
//     });
// });

app.get('/employee/:id/leave-summary', (req, res) => {
    const employeeId = req.params.id;

    const query = `
        SELECT ld.leave_date AS date,
               SUM(ld.duration) AS net_amount,
               lr.type_of_leave AS leave_type,
               lr.request_status AS request_status,
               GROUP_CONCAT(CONCAT(ld.start_time, ' - ', ld.end_time)) AS time_intervals
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        WHERE lr.employee_id = ? 
          AND (lr.request_status = 'Approved'
          OR lr.request_status = 'HR Remove')
        GROUP BY ld.leave_date, lr.type_of_leave, lr.request_status
        ORDER BY ld.leave_date;
    `;

    db.query(query, [employeeId], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            res.status(500).send(err);
        } else {
            // Calculate total minutes for PTO
            results.forEach(result => {
                if (result.leave_type === 'Personal Time Off' && result.time_intervals) {
                    const timeIntervals = result.time_intervals.split(',');
                    let totalMinutes = 0;

                    timeIntervals.forEach(interval => {
                        const [startTime, endTime] = interval.split(' - ');
                        const start = moment(startTime, 'HH:mm');
                        const end = moment(endTime, 'HH:mm');
                        totalMinutes += end.diff(start, 'minutes');
                    });

                    result.net_amount = totalMinutes / 60; // Convert minutes to hours
                }
            });

            res.send(results);
        }
    });
});



app.patch('/leave-requests/:id/cancel', authenticateToken, (req, res) => {
    const id = req.params.id;

    const fetchQuery = `
        SELECT lr.employee_id, lr.request_status
        FROM leave_requests lr
        WHERE lr.id = ? AND (lr.request_status = 'Pending Manager' OR lr.request_status = 'Approved')
    `;
    db.query(fetchQuery, [id], (err, result) => {
        if (err) {
            console.error('Error fetching leave request:', err);
            res.status(500).send(err);
        } else if (result.length === 0) {
            res.status(404).send({ message: 'Leave request not found or already processed' });
        } else {
            const { employee_id, request_status } = result[0];
            let updateRequestQuery;

            if (request_status === 'Pending Manager') {
                updateRequestQuery = `
                    UPDATE leave_requests 
                    SET request_status = 'Cancelled', last_modified = NOW() 
                    WHERE id = ? AND request_status = 'Pending Manager'
                `;
            } else if (request_status === 'Approved') {
                updateRequestQuery = `
                    UPDATE leave_requests 
                    SET request_status = 'Cancel Requested', last_modified = NOW() 
                    WHERE id = ? AND request_status = 'Approved'
                `;
            }

            db.query(updateRequestQuery, [id], (err, updateResult) => {
                if (err) {
                    console.error('Error updating leave request:', err);
                    res.status(500).send(err);
                } else {
                    res.send({ message: 'Leave request updated' });
                }
            });
        }
    });
});
app.patch('/leave-requests/:id/approve', authenticateToken, (req, res) => {
    const id = req.params.id;

    const fetchQuery = `
        SELECT lr.employee_id, lr.type_of_leave, SUM(ld.duration) as quantity, GROUP_CONCAT(ld.leave_date) AS dates
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        WHERE lr.id = ? AND lr.request_status = 'Pending Manager'
        GROUP BY lr.id
    `;
    db.query(fetchQuery, [id], (err, result) => {
        if (err) {
            console.error('Error fetching leave request:', err);
            res.status(500).send(err);
        } else if (result.length === 0) {
            res.status(404).send({ message: 'Leave request not found or already processed' });
        } else {
            const { employee_id, type_of_leave, quantity, dates } = result[0];

            const updateRequestQuery = `
                UPDATE leave_requests 
                SET request_status = 'Approved', last_modified = NOW() 
                WHERE id = ? AND request_status = 'Pending Manager'
            `;
            db.query(updateRequestQuery, [id], (err, updateResult) => {
                if (err) {
                    console.error('Error approving leave request:', err);
                    res.status(500).send(err);
                } else {
                    // Only update days if the leave type is not 'Sick Leave With Note' or 'Sick Leave Without Note'
                    if (type_of_leave !== 'Sick Leave With Note' && type_of_leave !== 'Sick Leave Without Note' && type_of_leave !== 'Personal Time Off') {
                        const updateDaysQuery = `
                            UPDATE employee 
                            SET days = days - ? 
                            WHERE id = ?
                        `;
                        db.query(updateDaysQuery, [quantity, employee_id], (err, updateDaysResult) => {
                            if (err) {
                                console.error('Error updating employee days:', err);
                                res.status(500).send(err);
                            } else {
                                res.send({ message: 'Leave request approved and days updated' });
                            }
                        });
                    } else {
                        res.send({ message: 'Leave request approved without updating days for sick leave' });
                    }
                }
            });
        }
    });
});

app.get('/previous-sick-leave-days/:employeeId', authenticateToken, (req, res) => {
    const employeeId = req.params.employeeId;

    const query = `
        SELECT SUM(quantity) as total
        FROM leave_requests
        WHERE employee_id = ? AND type_of_leave = 'Sick Leave Without Note' AND request_status != 'Cancelled'
    `;

    db.query(query, [employeeId], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            return res.status(500).send(err);
        }
        const totalDaysWithoutNote = results[0].total || 0;
        res.send({ total: totalDaysWithoutNote });
    });
});









app.patch('/leave-requests/:id/reject', authenticateToken, (req, res) => {
    const id = req.params.id;

    const fetchQuery = `
        SELECT lr.employee_id, GROUP_CONCAT(ld.leave_date) AS dates, lr.type_of_leave as typeOfLeave
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        WHERE lr.id = ? AND lr.request_status = 'Pending Manager'
        GROUP BY lr.id
    `;
    db.query(fetchQuery, [id], (err, result) => {
        if (err) {
            console.error('Error fetching leave request:', err);
            res.status(500).send(err);
        } else if (result.length === 0) {
            res.status(404).send({ message: 'Leave request not found or already processed' });
        } else {
            const { employee_id, dates, typeOfLeave } = result[0];

            const updateRequestQuery = `
                UPDATE leave_requests 
                SET request_status = 'Rejected', last_modified = NOW() 
                WHERE id = ? AND request_status = 'Pending Manager'
            `;
            db.query(updateRequestQuery, [id], (err, updateResult) => {
                if (err) {
                    console.error('Error rejecting leave request:', err);
                    res.status(500).send(err);
                } else {
                    res.send({ message: 'Leave request rejected' });
                }
            });
        }
    });
});


app.get('/unavailable-dates/:id', authenticateToken, (req, res) => {
    const id = req.params.id;
    const query = `
        SELECT 
            CASE 
                WHEN main.duration >= '1' THEN 'NONE'
                WHEN main.duration = 0.5 AND main.time = 'AM' THEN 'HD-AM'
                WHEN main.duration = 0.5 AND main.time = 'PM' THEN 'HD-PM'
                ELSE 'N/A'
            END AS action,
            main.leave_date as date
        FROM (
            SELECT  
                ld.duration,
                ld.leave_date,
                ld.time
            FROM leave_requests lr
            JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
            WHERE lr.employee_id = ?
              AND lr.request_status != 'Cancelled'
        ) main
    `;

    db.query(query, [id], (err, results) => {
        if (err) res.send(err);
        else {
            res.send(results);
        } 
    });
});


app.patch('/leave-requests/:id/cancel-approve', authenticateToken, (req, res) => {
    const id = req.params.id;

    const fetchQuery = `
        SELECT lr.employee_id, lr.type_of_leave, SUM(ld.duration) as quantity, GROUP_CONCAT(ld.leave_date) AS dates
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        WHERE lr.id = ? AND lr.request_status = 'Cancel Requested'
        GROUP BY lr.id
    `;
    db.query(fetchQuery, [id], (err, result) => {
        if (err) {
            console.error('Error fetching leave request:', err);
            return res.status(500).send(err);
        } 
        
        if (result.length === 0) {
            console.warn(`No cancel request found for leave request ID: ${id}`);
            return res.status(404).send({ message: 'Cancel request not found or already processed' });
        }
        
        const { employee_id, type_of_leave, quantity, dates } = result[0];

        const updateRequestQuery = `
            UPDATE leave_requests 
            SET request_status = 'Cancelled', last_modified = NOW() 
            WHERE id = ? AND request_status = 'Cancel Requested'
        `;
        db.query(updateRequestQuery, [id], (err, updateResult) => {
            if (err) {
                console.error('Error approving cancel request:', err);
                return res.status(500).send(err);
            } 
            
            // Only update days if the leave type is not 'Sick Leave'
            if (type_of_leave !== 'Sick Leave') {
                const updateDaysQuery = `
                    UPDATE employee 
                    SET days = days + ? 
                    WHERE id = ?
                `;
                db.query(updateDaysQuery, [quantity, employee_id], (err, updateDaysResult) => {
                    if (err) {
                        console.error('Error updating employee days:', err);
                        return res.status(500).send(err);
                    } 

                    res.send({ message: 'Cancel request approved and days updated' });
                });
            } else {
                res.send({ message: 'Cancel request approved without updating days for sick leave' });
            }
        });
    });
});

app.patch('/leave-requests/:id/cancel-reject', authenticateToken, (req, res) => {
    const id = req.params.id;

    const updateRequestQuery = `
        UPDATE leave_requests 
        SET request_status = 'Approved', last_modified = NOW() 
        WHERE id = ? AND request_status = 'Cancel Requested'
    `;
    db.query(updateRequestQuery, [id], (err, updateResult) => {
        if (err) {
            console.error('Error rejecting cancel request:', err);
            res.status(500).send(err);
        } else {
            res.send({ message: 'Cancel request rejected and status reverted to approved' });
        }
    });
});

app.patch('/leave-requests/:id/edit', authenticateToken, (req, res) => {
    const id = req.params.id;
    const { typeOfLeave, quantity, leaveDetails, note } = req.body;

    const updateRequestQuery = `
        UPDATE leave_requests 
        SET type_of_leave = ?, quantity = ?, start_date = ?, end_date = ?, note = ?, last_modified = NOW() 
        WHERE id = ? AND request_status = 'Pending Manager'
    `;

    const startDate = leaveDetails[0].date;
    const endDate = leaveDetails[leaveDetails.length - 1].date;

    db.query(updateRequestQuery, [typeOfLeave, quantity, startDate, endDate, note, id], (err, result) => {
        if (err) {
            console.error('Error updating leave request:', err);
            res.status(500).send(err);
        } else {
            const deleteDatesQuery = `
                DELETE FROM leave_request_dates WHERE leave_request_id = ?
            `;

            db.query(deleteDatesQuery, [id], (err, deleteResult) => {
                if (err) {
                    console.error('Error deleting leave request dates:', err);
                    res.status(500).send(err);
                } else {
                    const dateQueries = leaveDetails.map(detail => (
                        new Promise((resolve, reject) => {
                            const dateQuery = `
                                INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, time)
                                VALUES (?, ?, ?, ?)
                            `;
                            db.query(dateQuery, [id, detail.date, detail.duration, detail.time], (err, dateResult) => {
                                if (err) reject(err);
                                else resolve(dateResult);
                            });
                        })
                    ));

                    Promise.all(dateQueries)
                        .then(() => {
                            res.send({ message: 'Leave request updated successfully' });
                        })
                        .catch(err => {
                            console.error('Error adding leave request dates:', err);
                            res.status(500).send(err);
                        });
                }
            });
        }
    });
});

app.get('/department-leaves', authenticateToken, (req, res) => {
    const userId = req.user.id;

    const query = `
        SELECT 
            e.id AS employee_id,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
            lr.type_of_leave,
            lr.request_status,
            ld.leave_date,
            ld.duration,
            ld.time
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        JOIN employee e ON lr.employee_id = e.id
        WHERE e.manager_id = ? OR e.id IN (
            SELECT id FROM employee WHERE department_id = (
                SELECT department_id FROM employee WHERE id = ?
            )
        )
        AND lr.request_status IN ('Approved', 'Pending Manager')
    `;
    db.query(query, [userId, userId], (err, result) => {
        if (err) res.status(500).send(err);
        else res.send(result);
    });
});


// Function to add birthday leave
function addBirthdayLeave() {
    const today = moment().format('MM-DD');
    
    const query = `
        SELECT id, first_name, last_name 
        FROM employee 
        WHERE DATE_FORMAT(birthday, '%m-%d') = ?
    `;

    db.query(query, [today], (err, results) => {
        if (err) {
            console.error('Error fetching employees with birthdays:', err);
            return;
        }

        results.forEach(employee => {
            const updateQuery = `UPDATE employee SET days = days + 1 WHERE id = ?`;
            db.query(updateQuery, [employee.id], (updateErr, updateResult) => {
                if (updateErr) {
                    console.error(`Error updating leave days for employee ID ${employee.id}:`, updateErr);
                    return;
                }

                // Insert leave request for the birthday leave
                const leaveRequestQuery = `
                    INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
                    VALUES (?, 'Birthday', 'Add', 1, NOW(), NOW(), NOW())
                `;
                db.query(leaveRequestQuery, [employee.id], (leaveErr, leaveResult) => {
                    if (leaveErr) {
                        console.error('Error inserting leave request for birthday leave:', leaveErr);
                        return;
                    }

                    const dateQuery = `
                        INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, time)
                        VALUES (?, NOW(), ?, ?)
                    `;
                    db.query(dateQuery, [leaveResult.insertId, 1, null]);

                    const logQuery = `
                        INSERT INTO logs (hr_user, action, details, timestamp)
                        VALUES (?, 'Birthday', 'Added 1 day for birthday to ${employee.first_name} ${employee.last_name}', NOW())
                    `;
                    db.query(logQuery, [employee.id], (logErr, logResult) => {
                        if (logErr) {
                            console.error('Error logging birthday leave addition:', logErr);
                        }
                    });
                });
            });
        });
    });
}

// Schedule the addBirthdayLeave function to run daily at midnight
cron.schedule('0 0 * * *', () => {
    addBirthdayLeave();
});

app.post('/holiday', hrAuthenticateToken, async (req, res) => {
    const { startDate, endDate, description } = req.body;
    const formattedStartDate = moment(startDate).format('YYYY-MM-DD');
    const formattedEndDate = moment(endDate).format('YYYY-MM-DD');

    const holidayQuery = `
        INSERT INTO holidays (start_date, end_date, description) VALUES (?, ?, ?)
    `;
    
    db.query(holidayQuery, [formattedStartDate, formattedEndDate, description], (err, result) => {
        if (err) {
            console.error('Error inserting holiday:', err);
            return res.status(500).send(err);
        }

        const findLeaveRequestsQuery = `
            SELECT lr.id, lr.employee_id, lr.type_of_leave, lr.quantity, lrd.duration, lrd.leave_date, lr.request_status
            FROM leave_requests lr
            JOIN leave_request_dates lrd ON lr.id = lrd.leave_request_id
            WHERE lrd.leave_date BETWEEN ? AND ?
            AND lr.request_status IN ('Approved', 'Pending Manager')
        `;

        db.query(findLeaveRequestsQuery, [formattedStartDate, formattedEndDate], (err, result) => {
            if (err) {
                console.error('Error finding leave requests:', err);
                return res.status(500).send(err);
            }

            const leaveRequests = result;
            const updateRequests = leaveRequests.map(request => {
                return new Promise((resolve, reject) => {
                    db.query(`UPDATE leave_requests SET request_status = 'Cancelled' WHERE id = ?`, [request.id], (err, result) => {
                        if (err) {
                            console.error('Error updating leave request status:', err);
                            return reject(err);
                        }

                        if ((request.type_of_leave === 'Annual Paid Leave' || request.type_of_leave === 'Unpaid Leave') && request.request_status === 'Approved') {
                            db.query(`
                                UPDATE employee
                                SET days = days + ?
                                WHERE id = ?
                            `, [request.duration, request.employee_id], (err, result) => {
                                if (err) {
                                    console.error('Error updating employee days:', err);
                                    return reject(err);
                                }
                                resolve();
                            });
                        } else {
                            resolve();
                        }
                    });
                });
            });

            Promise.all(updateRequests)
                .then(() => res.send({ message: 'Holiday added and leave requests updated successfully' }))
                .catch(err => {
                    console.error('Error updating leave requests:', err);
                    res.status(500).send(err);
                });
        });
    });
});



app.get('/all-department-leaves', hrAuthenticateToken, (req, res) => {
    const query = `
        SELECT 
            e.id AS employee_id,
            CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
            lr.type_of_leave,
            lr.request_status,
            ld.leave_date,
            ld.duration,
            ld.time
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        JOIN employee e ON lr.employee_id = e.id
        WHERE lr.request_status IN ('Approved', 'Pending Manager')
    `;
    db.query(query, (err, result) => {
        if (err) res.status(500).send(err);
        else res.send(result);
    });
});
app.get('/remaining-timeoff/:employeeId', authenticateToken, (req, res) => {
    const employeeId = req.params.employeeId;
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const checkPTOQuery = `
        SELECT SUM(TIMESTAMPDIFF(MINUTE, start_time, end_time)) as totalMinutes
        FROM leave_request_dates
        JOIN leave_requests ON leave_request_dates.leave_request_id = leave_requests.id
        WHERE leave_requests.employee_id = ? AND leave_requests.type_of_leave = 'Personal Time Off'
        AND MONTH(leave_request_dates.leave_date) = ? AND YEAR(leave_request_dates.leave_date) = ?
        AND leave_requests.request_status != 'Cancelled'
    `;

    db.query(checkPTOQuery, [employeeId, currentMonth, currentYear], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            return res.status(500).send(err);
        }

        const totalMinutesTaken = parseFloat(results[0].totalMinutes) || 0;
        const remainingMinutes = Math.max(0, 120 - totalMinutesTaken);
        res.send({ remainingMinutes });
    });
});
