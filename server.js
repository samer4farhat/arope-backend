const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./src/db_config/db_config.js');
var cors = require('cors');
const cron = require('node-cron');
const moment = require('moment');
const e = require('express');

const app = express();

// CONSTANTS
const zalkaLocationId = 1;

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

const roundLeaveDays = (days) => {
    const decimalPart = days - Math.floor(days);
    let roundedDays = Math.floor(days);
    if (decimalPart >= 0.75) {
        roundedDays = Math.ceil(days);
    } else if (decimalPart > 0.25 && decimalPart < 0.75) {
        roundedDays = Math.floor(days) + 0.5;
    }
    return roundedDays;
};

const isManager = (employeeId) => {
    return new Promise((resolve, reject) => {
        const checkManagerQuery = `
            SELECT COUNT(*) AS isManager
            FROM department
            WHERE manager_id = ?
        `;
        db.query(checkManagerQuery, [employeeId], (err, results) => {
            if (err) {
                console.error('Error checking if employee is a manager:', err);
                return reject(err);
            }
            resolve(results[0].isManager > 0);
        });
    });
};

//Calculating leave days of employees who are added 
const calculateLeaveDaysForPartialYear = (startDate, endDate, isManager) => {
    const startMoment = moment(startDate, 'YYYY-MM-DD');
    const leaveDaysPerYear = isManager ? 21 : 15;
    const leaveDaysPerMonth = leaveDaysPerYear / 12;

    let totalLeaveDays = 0;

    // Calculate the prorated leave days for the start month
    const daysInStartMonth = startMoment.daysInMonth();
    const startMonthFraction = (daysInStartMonth - startMoment.date() + 1) / daysInStartMonth;
    totalLeaveDays += startMonthFraction * leaveDaysPerMonth;

    // If an end date is provided and it falls within the same year, calculate for the end month
    if (endDate) {
        const endMoment = moment(endDate, 'YYYY-MM-DD');
        console.log(endMoment)

        // If the end date is within the same year as the start date
        if (endMoment.year() === startMoment.year()) {
            const daysInEndMonth = endMoment.daysInMonth();
            const endMonthFraction = endMoment.date() / daysInEndMonth;
            totalLeaveDays += endMonthFraction * leaveDaysPerMonth;
            console.log("initial: "+totalLeaveDays)


            // Add leave days for full months between start and end dates
            const fullMonthsBetween = endMoment.diff(startMoment, 'months') - 1;
            totalLeaveDays += fullMonthsBetween * leaveDaysPerMonth;
            console.log("final: "+totalLeaveDays)
        }
    } else {
        // If no end date is provided or it's in the next year, calculate for the full months remaining in the year
        const fullMonthsLeft = 11 - startMoment.month();
        totalLeaveDays += fullMonthsLeft * leaveDaysPerMonth;
    }

    return roundLeaveDays(totalLeaveDays);
};


const calculateLeaveDaysPerYear = (yearsOfService, isManager) => {
    if (isManager) {
        return 21;
    } else if (yearsOfService >= 15) {
        return 21;
    } else if (yearsOfService >= 5) {
        return 18;
    } else {
        return 15;
    }
};

const setLeaveDaysOnPromotion = (employeeId, promotionDate) => {
    return new Promise(async (resolve, reject) => {
        const getEmployeeQuery = `SELECT start_date, days FROM employee WHERE id = ?`;

        db.query(getEmployeeQuery, [employeeId], async (err, results) => {
            if (err) {
                console.error('Error fetching employee details:', err);
                return reject(err);
            }

            const { start_date: startDate, days: currentDays } = results[0];
            console.log(`Employee details for promotion - Start Date: ${startDate}, Current Days: ${currentDays}`);

            const promotionMoment = moment(promotionDate);
            const startMoment = moment(startDate);
            const yearsOfService = promotionMoment.diff(startMoment, 'years');

            // Check if the employee is a manager
            const isManagerStatus = await isManager(employeeId);

            // Same day promotion check
            var isSameDay = false;
            let roundedAdjustedDays;

            // Determine leave days per year
            const initialLeaveDaysPerYear = calculateLeaveDaysPerYear(yearsOfService, isManagerStatus);

            // Calculate the initial prorated days added at the start
            let initialProratedDaysAdded;
            if (startMoment.year() === promotionMoment.year()) {
                if ((startMoment.month() === promotionMoment.month()) && (startMoment.date() === promotionMoment.date())) {
                    // Employee started on the promotion date
                    const daysInStartMonth = startMoment.daysInMonth();
                    const startMonthDaysFraction = (daysInStartMonth - startMoment.date() + 1) / daysInStartMonth;
                    const monthsLeftTillEndOfYear = 11 - startMoment.month();
                    const adjustedDays = (21 / 12) * (startMonthDaysFraction + monthsLeftTillEndOfYear);

                    roundedAdjustedDays = roundLeaveDays(adjustedDays);
                    console.log(roundedAdjustedDays);

                    isSameDay = true;
                } else {
                    // Employee started earlier in the year
                    const daysInStartMonth = startMoment.daysInMonth();
                    const startMonthDaysFraction = (daysInStartMonth - startMoment.date() + 1) / daysInStartMonth;
                    const monthsLeftTillEndOfYear = 11 - startMoment.month();

                    const monthsAsEmployee = startMonthDaysFraction + monthsLeftTillEndOfYear;
                    initialProratedDaysAdded = (15 / 12) * monthsAsEmployee;
                }
            } else {
                // Employee started in a previous year, so full year days were added at the start of the year
                initialProratedDaysAdded = initialLeaveDaysPerYear;
            }

            if (isSameDay) {
                const updateQuery = `UPDATE employee SET days = ? WHERE id = ?`;
                db.query(updateQuery, [roundedAdjustedDays, employeeId], (err, result) => {
                    if (err) {
                        console.error('Error updating leave days:', err);
                        return reject(err);
                    }
                    console.log(`Leave days updated for employee ID ${employeeId}: ${roundedAdjustedDays}`);
                    resolve(result);
                });
            } else {
                console.log(`Initial Prorated Days Added: ${initialProratedDaysAdded}`);

                // Calculate prorated days before promotion
                const daysInStartMonth = startMoment.daysInMonth();
                const startMonthDaysFraction = (daysInStartMonth - startMoment.date() + 1) / daysInStartMonth;
                const monthsLeftTillPromotion = promotionMoment.month() - startMoment.month() - 1;
                const promotionMonthDaysFraction = promotionMoment.date() / promotionMoment.daysInMonth();

                const monthsAsEmployee = startMonthDaysFraction + monthsLeftTillPromotion + promotionMonthDaysFraction;
                const proratedDaysAsEmployee = (15 / 12) * monthsAsEmployee;

                console.log(`Months as Employee: ${monthsAsEmployee}`);
                console.log(`Prorated Days as Employee: ${proratedDaysAsEmployee}`);

                // Calculate prorated days after promotion as manager
                const daysInPromotionMonth = promotionMoment.daysInMonth();
                const promotionMonthDaysFractionAfter = (daysInPromotionMonth - promotionMoment.date() + 1) / daysInPromotionMonth;
                const fullMonthsBetweenPromotionAndEndOfYear = 11 - promotionMoment.month();

                const monthsAsManager = promotionMonthDaysFractionAfter + fullMonthsBetweenPromotionAndEndOfYear;
                const proratedDaysAsManager = (21 / 12) * monthsAsManager;

                console.log(`Months as Manager: ${monthsAsManager}`);
                console.log(`Prorated Days as Manager: ${proratedDaysAsManager}`);

                // Calculate total new prorated days
                const totalProratedDays = proratedDaysAsEmployee + proratedDaysAsManager;

                // Adjust current leave days
                let adjustedDays = currentDays - roundLeaveDays(initialProratedDaysAdded) + totalProratedDays;

                roundedAdjustedDays = roundLeaveDays(adjustedDays);

                console.log(`Adjusted Days (before rounding): ${adjustedDays}`);
                console.log(`Rounded Adjusted Days: ${roundedAdjustedDays}`);

                const updateQuery = `UPDATE employee SET days = ? WHERE id = ?`;
                db.query(updateQuery, [roundedAdjustedDays, employeeId], (err, result) => {
                    if (err) {
                        console.error('Error updating leave days:', err);
                        return reject(err);
                    }
                    console.log(`Leave days updated for employee ID ${employeeId}: ${roundedAdjustedDays}`);
                    resolve(result);
                });
            }
        });
    });
};

const adjustLeaveDaysOnServiceAnniversary = (employeeId, adjustmentDate) => {
    return new Promise((resolve, reject) => {
        const checkIfManagerQuery = `SELECT * FROM arope_db.department WHERE manager_id = ?`;

        db.query(checkIfManagerQuery, [employeeId], (err, results) => {
            if (results.length != 0) {
                return resolve();
            }
        })

        const getEmployeeQuery = `SELECT start_date, days FROM employee WHERE id = ?`;
        db.query(getEmployeeQuery, [employeeId], (err, results) => {
            if (err) {
                console.error('Error fetching employee details:', err);
                return reject(err);
            }

            const { start_date: startDate, days: currentDays } = results[0];
            console.log(`Employee details - Start Date: ${startDate}, Current Days: ${currentDays}`);

            const adjustmentMoment = moment(adjustmentDate);
            const startMoment = moment(startDate);

            let yearsOfService = adjustmentMoment.diff(startMoment, 'years');
            console.log(`Calculated Years of Service (initial): ${yearsOfService}`);

            // Adjust yearsOfService if today is the anniversary date
            if (adjustmentMoment.month() === startMoment.month() && adjustmentMoment.date() === startMoment.date()) {
                yearsOfService += 1;
            }

            console.log(`Years of Service (after anniversary check): ${yearsOfService}`);
            console.log(`Adjustment Moment: ${adjustmentMoment.format('YYYY-MM-DD')}`);
            console.log(`Start Moment: ${startMoment.format('YYYY-MM-DD')}`);

            const daysInServiceChangeMonth = adjustmentMoment.daysInMonth();
            const serviceChangeMonthDaysFractionBefore = (adjustmentMoment.date()) / daysInServiceChangeMonth;
            const monthsBeforeServiceChange = adjustmentMoment.month();
            const monthsAfterServiceChange = 11 - monthsBeforeServiceChange;
            const serviceChangenMonthDaysFractionAfter = (daysInServiceChangeMonth - adjustmentMoment.date() + 1) / daysInServiceChangeMonth;

            console.log(`Months Before Service Change: ${monthsBeforeServiceChange}`);
            console.log(`Months After Service Change: ${monthsAfterServiceChange}`);

            let leaveDaysBeforeAdjustment, leaveDaysAfterAdjustment;

            if (yearsOfService === 5) {
                leaveDaysBeforeAdjustment = 15;
                leaveDaysAfterAdjustment = 18;
            } else if (yearsOfService === 15) {
                leaveDaysBeforeAdjustment = 18;
                leaveDaysAfterAdjustment = 21;
            } else {
                console.log(`No adjustment needed for employee ID: ${employeeId} - not hitting 5 or 15 years milestone`);
                return resolve(); // No adjustment needed if not hitting 5 or 15 years milestone
            }

            const leaveDaysAccruedBeforeAdjustment = (leaveDaysBeforeAdjustment / 12) * (monthsBeforeServiceChange + serviceChangeMonthDaysFractionBefore);
            const leaveDaysAccruedAfterAdjustment = (leaveDaysAfterAdjustment / 12) * (monthsAfterServiceChange + serviceChangenMonthDaysFractionAfter);

            // Calculate days added at the start of the year
            const initialProratedDaysAdded = yearsOfService === 5 ? 15 : 18;

            console.log(`Leave Days Before Adjustment: ${leaveDaysBeforeAdjustment}`);
            console.log(`Leave Days After Adjustment: ${leaveDaysAfterAdjustment}`);
            console.log(`Leave Days Accrued Before Adjustment: ${leaveDaysAccruedBeforeAdjustment}`);
            console.log(`Leave Days Accrued After Adjustment: ${leaveDaysAccruedAfterAdjustment}`);
            console.log(`Initial Prorated Days Added: ${initialProratedDaysAdded}`);

            let newLeaveDays = currentDays - initialProratedDaysAdded + leaveDaysAccruedBeforeAdjustment + leaveDaysAccruedAfterAdjustment;

            console.log(`New Leave Days (before rounding): ${newLeaveDays}`);
            const roundedNewLeaveDays = roundLeaveDays(newLeaveDays);

            console.log(`Rounded New Leave Days: ${roundedNewLeaveDays}`);

            const updateQuery = `UPDATE employee SET days = ? WHERE id = ?`;
            db.query(updateQuery, [roundedNewLeaveDays, employeeId], (err, result) => {
                if (err) {
                    console.error('Error updating leave days:', err);
                    return reject(err);
                }
                console.log(`Leave days updated for employee ID: ${employeeId}`);
                resolve(result);
            });
        });
    });
};
const calculateLeaveDays = (startDate, endDate, isManager, yearsOfService) => {
    const startMoment = moment(startDate, 'YYYY-MM-DD');
    const currentYear = moment().year();
    const leaveDaysPerYear = isManager ? 21 : (yearsOfService >= 15 ? 21 : (yearsOfService >= 5 ? 18 : 15));
    const leaveDaysPerMonth = leaveDaysPerYear / 12;

    console.log(`Calculating leave days...`);
    console.log(`Start Date: ${startDate}`);
    console.log(`End Date: ${endDate ? endDate : 'N/A'}`);
    console.log(`Is Manager: ${isManager}`);
    console.log(`Years of Service: ${yearsOfService}`);
    console.log(`Leave Days Per Year: ${leaveDaysPerYear}`);
    console.log(`Leave Days Per Month: ${leaveDaysPerMonth}`);

    let totalLeaveDays = 0;

    if (endDate && moment(endDate).year() === currentYear) {
        // The employee is ending within the current year

        const endMoment = moment(endDate, 'YYYY-MM-DD');
        const daysInEndMonth = endMoment.daysInMonth();

        // Calculate months between Jan 1 and the end month (excluding end month)
        const fullMonthsBeforeEnd = endMoment.month(); // January is month 0, so this counts correctly

        // Calculate fraction of the end month worked
        const endMonthFraction = endMoment.date() / daysInEndMonth;

        // Total leave days: full months + partial end month
        totalLeaveDays = (fullMonthsBeforeEnd + endMonthFraction) * leaveDaysPerMonth;

        console.log(`End Date is within the current year.`);
        console.log(`End Month: ${endMoment.format('MMMM')}`);
        console.log(`Full Months Before End: ${fullMonthsBeforeEnd}`);
        console.log(`End Month Fraction: ${endMonthFraction}`);
        console.log(`Leave Days for Partial Year: ${totalLeaveDays}`);
    } else {
        // No end date provided or end date is outside the current year
        // Full 12 months of leave

        totalLeaveDays = leaveDaysPerMonth * 12;

        console.log(`No End Date or End Date is beyond the current year.`);
        console.log(`Leave Days for Full Year: ${totalLeaveDays}`);
    }

    console.log(`Total Leave Days before rounding: ${totalLeaveDays}`);
    const roundedLeaveDays = roundLeaveDays(totalLeaveDays);
    console.log(`Rounded Leave Days: ${roundedLeaveDays}`);

    return roundedLeaveDays;
};

const updateLeaveDaysOnJan1 = () => {
    return new Promise((resolve, reject) => {
        const currentYear = moment().year();
        const getEmployeesQuery = `
            SELECT id, start_date, end_date 
            FROM employee WHERE id=743
        `;

        db.query(getEmployeesQuery, (err, employees) => {
            if (err) {
                console.error('Error fetching employees:', err);
                return reject(err);
            }

            const updatePromises = employees.map(employee => {
                const { id, start_date, end_date } = employee;
                const startMoment = moment(start_date);
                const yearsOfService = currentYear - startMoment.year();

                return isManager(id).then(isManager => {
                    let leaveDays;

                    if (end_date && moment(end_date).year() === currentYear) {
                        // Prorate leave days if the end date is within the current year
                        leaveDays = calculateLeaveDays(start_date, end_date, isManager, yearsOfService, 0, 12);
                    } else {
                        // Full leave days if no end date or end date is outside the current year
                        leaveDays = calculateLeaveDays(start_date, null, isManager, yearsOfService, 0, 12);
                    }
                    console.log(`Calculated Leave Days for Employee ID ${id}: ${leaveDays}`);
                    const updateQuery = `UPDATE employee SET days = days + ? WHERE id = ?`;
                    return db.query(updateQuery, [leaveDays, id]);
                });
            });

            Promise.all(updatePromises)
                .then(results => {
                    console.log('Leave days updated successfully for all employees');
                    resolve(results);
                })
                .catch(err => {
                    console.error('Error updating leave days:', err);
                    reject(err);
                });
        });
    });
};



// Schedule the updateLeaveDaysOnJan1 
cron.schedule('0 0 1 1 *', () => {
    console.log('Starting leave days update at 00:00 AM...');
    updateLeaveDaysOnJan1()
        .then(() => {
            console.log('Leave days updated for all employees');
        })
        .catch(err => {
            console.error('Error running the leave update:', err);
        });
});

const checkAndAdjustServiceAnniversaries = () => {
    return new Promise((resolve, reject) => {
        const currentDate = moment().format('MM-DD');
        console.log(`Current Date for Anniversary Check: ${currentDate}`);

        const getEmployeesQuery = `
            SELECT id, start_date 
            FROM employee 
            WHERE DATE_FORMAT(start_date, '%m-%d') = ?
        `;
        
        db.query(getEmployeesQuery, [currentDate], (err, employees) => {
            if (err) {
                console.error('Error fetching employees:', err);
                return reject(err);
            }

            console.log(`Employees with service anniversary today: ${employees.length}`);
            employees.forEach(employee => {
                console.log(`Employee ID: ${employee.id}, Start Date: ${employee.start_date}`);
            });

            const adjustmentPromises = employees.map(employee => {
                return adjustLeaveDaysOnServiceAnniversary(employee.id, moment().format('YYYY-MM-DD'))
                    .then(() => {
                        console.log(`Leave days adjusted for employee ID: ${employee.id}`);
                    })
                    .catch(err => {
                        console.error(`Error adjusting leave days for employee ID: ${employee.id}`, err);
                    });
            });

            Promise.all(adjustmentPromises)
                .then(results => {
                    console.log('Leave days adjusted successfully for service anniversaries');
                    resolve(results);
                })
                .catch(err => {
                    console.error('Error adjusting leave days:', err);
                    reject(err);
                });
        });
    });
};

// Schedule the checkAndAdjustServiceAnniversaries function to run daily 
cron.schedule('00 00 * * *', () => {
    console.log('Starting daily service anniversary check at 00:00 AM...');
    checkAndAdjustServiceAnniversaries()
        .then(() => {
            console.log('Service anniversary check completed');
        })
        .catch(err => {
            console.error('Error running the service anniversary check:', err);
        });
});
app.get('/employee', hrAuthenticateToken, (req, res) => {
    var query = `
        SELECT 
            e.id, 
            e.first_name,
            e.last_name,   
            e.email, 
            e.days, 
            d.name AS "department_name", 
            e.manager_id, 
            CONCAT(me.first_name, ' ', me.last_name) AS manager_full_name,  
            e.birthday, 
            e.start_date, 
            e.end_date, 
            l.location_name,
            CASE 
                WHEN l.location_name = 'Zalka' AND e.id != d.supervisor_id AND e.id != d.manager_id THEN CONCAT(sup.first_name, ' ', sup.last_name)
                WHEN l.location_name != 'Zalka' AND e.id != l.branch_manager_id THEN CONCAT(bm.first_name, ' ', bm.last_name)
                ELSE NULL
            END AS first_approver_name,
            -- Subquery to calculate leaves taken in the current year
            COALESCE(SUM(CASE WHEN (YEAR(ld.leave_date) = YEAR(CURDATE()) AND (lr.request_status = 'Approved' OR 'HR Remove')) THEN ld.duration ELSE 0 END), 0) AS leaves_taken,
            COALESCE(SUM(CASE WHEN (YEAR(ld.leave_date) = YEAR(CURDATE()) AND (lr.request_status = 'Approved' OR 'HR Remove') AND lr.type_of_leave IN ("Sick Leave With Note", "Sick Leave Without Note")) THEN ld.duration ELSE 0 END), 0) AS sick_leaves_taken
        FROM employee e
        LEFT JOIN department d ON e.department_id = d.id
        LEFT JOIN employee me ON e.manager_id = me.id
        LEFT JOIN location l ON e.location_id = l.id
        LEFT JOIN employee sup ON d.supervisor_id = sup.id
        LEFT JOIN employee bm ON l.branch_manager_id = bm.id
        LEFT JOIN leave_requests lr ON e.id = lr.employee_id
        LEFT JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        GROUP BY e.id
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});
app.get('/employee/:id', (req, res) => {
    const id = req.params.id;
    const query = `
        SELECT 
            e.id, 
            e.first_name, 
            e.middle_name, 
            e.last_name, 
            e.email, 
            e.days, 
            d.id AS "department_id", 
            d.name AS "department_name", 
            e.manager_id, 
            me.first_name AS "manager_first_name", 
            me.last_name AS "manager_last_name", 
            e.birthday, 
            e.start_date, 
            e.end_date,
            EXISTS(
                SELECT 1 FROM department WHERE manager_id = e.id
            ) AS is_manager,
            l.location_name,
            CASE 
                WHEN (e.id = s.id OR e.id = bm.id OR (SELECT 1 FROM department WHERE manager_id = e.id) = 1) THEN NULL
                WHEN l.location_name = 'Zalka' THEN s.id
                ELSE bm.id
            END AS first_approver_id,
            CASE 
                WHEN (e.id = s.id OR e.id = bm.id OR (SELECT 1 FROM department WHERE manager_id = e.id)) THEN NULL
                WHEN l.location_name = 'Zalka' THEN s.first_name
                ELSE bm.first_name
            END AS first_approver_first_name,
            CASE 
                WHEN (e.id = s.id OR e.id = bm.id OR (SELECT 1 FROM department WHERE manager_id = e.id)) THEN NULL
                WHEN l.location_name = 'Zalka' THEN s.last_name
                ELSE bm.last_name
            END AS first_approver_last_name
        FROM employee e
        LEFT JOIN department d ON e.department_id = d.id
        LEFT JOIN employee me ON e.manager_id = me.id
        LEFT JOIN location l ON e.location_id = l.id
        LEFT JOIN employee s ON d.supervisor_id = s.id
		LEFT JOIN employee bm ON l.branch_manager_id = bm.id
        WHERE e.id = ?;
    `;
    db.query(query, [id], (err, result) => {
        if (err) res.status(500).send(err);
        else res.send(result[0]);
    });
});
app.post('/employee', hrAuthenticateToken, async (req, res) => {
    const { id, firstName, middleName, lastName, email, departmentId, managerId, birthday, startDate, endDate, locationId } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token

    // Check if managerId is provided, if not, set it to NULL
    const managerIdValue = managerId ? managerId : null;

            const query = `
        INSERT INTO employee 
        (id, first_name, middle_name, last_name, email, department_id, manager_id, birthday, start_date, end_date, location_id) 
        VALUES (?,?,?,?,?,?,?,?,?,?,?);
    `;
    db.query(query, [id, firstName, middleName, lastName, email, departmentId, managerIdValue, birthday, startDate, endDate, locationId], (err, result) => {
        if (err) {
            res.send(err);
        } else {
            const newEmployeeId = result.insertId;

            isManager(newEmployeeId).then(isManagerImmediately => {
                console.log(`New Employee ID: ${newEmployeeId}`);
                console.log(`Is Manager Immediately: ${isManagerImmediately}`);

                const proratedLeaveDays = calculateLeaveDaysForPartialYear(startDate, endDate, isManagerImmediately);

                console.log(`Prorated Leave Days: ${proratedLeaveDays}`);

                db.query(`UPDATE employee SET days = ? WHERE id = ?`, [proratedLeaveDays, newEmployeeId], (err, updateResult) => {
                    if (err) {
                        console.error('Error updating prorated leave days:', err);
                        res.status(500).send(err);
                    } else {
                        const details = `Created new employee: ${firstName} ${lastName} (ID: ${newEmployeeId}), Department: ${departmentId}, Manager: ${managerIdValue}, Start Date: ${startDate}, End Date: ${endDate}`;
                        addLog(hrUserId, 'Create Employee', details);
                        res.send({ id: newEmployeeId });
                    }
                });
            }).catch(err => {
                console.error('Error checking if employee is a manager:', err);
                res.status(500).send(err);
            });
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
            const { first_name, middle_name, last_name, email, department_id, manager_id, birthday, start_date, end_date, location_id } = updatedEmployee;

            const query = `
                UPDATE employee
                SET first_name = ?, middle_name = ?, last_name = ?, email = ?, department_id = ?, manager_id = ?, birthday = ?, start_date = ?, end_date = ?, location_id = ? 
                WHERE id = ?;
            `;
            db.query(query, [first_name, middle_name, last_name, email, department_id, manager_id, birthday, start_date, end_date, location_id, id], (err, result) => {
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
app.patch('/departments/:id', hrAuthenticateToken, (req, res) => {
    const departmentId = req.params.id;
    const { name, manager_id, supervisor_id } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from the token
    const promotionDate = moment().format('YYYY-MM-DD'); // Current date

    // Step 1: Fetch the current manager_id for the department
    const getCurrentManagerQuery = `
        SELECT manager_id
        FROM department
        WHERE id = ?;
    `;

    db.query(getCurrentManagerQuery, [departmentId], (err, result) => {
        if (err) {
            console.error('Error fetching current manager ID:', err);
            return res.status(500).send(err);
        }

        if (!result || result.length === 0) {
            console.error('Department not found');
            return res.status(404).send({ error: 'Department not found' });
        }

        const currentManagerId = result[0].manager_id;

        // Check if the manager_id has been updated
        const managerUpdated = manager_id !== undefined && manager_id !== null && manager_id !== currentManagerId;

        // Update the department's name, supervisor_id, and branch_manager_id
        const updateDepartmentQuery = `
            UPDATE department
            SET name = ?, supervisor_id = ?
            WHERE id = ?;
        `;

        db.query(updateDepartmentQuery, [name, supervisor_id, departmentId], (err, result) => {
            if (err) {
                console.error('Error updating department:', err);
                return res.status(500).send(err);
            }

                if (managerUpdated) {
                    console.log(`Manager ID has been updated to ${manager_id}, proceeding with manager-specific updates.`);

                    // Fetch the new manager's details
                    const getNewManagerQuery = `
                        SELECT start_date, days
                        FROM employee
                        WHERE id = ?;
                    `;

                    db.query(getNewManagerQuery, [manager_id], (err, result) => {
                        if (err) {
                            console.error('Error fetching new manager details:', err);
                            return res.status(500).send(err);
                        }

                        if (!result || result.length === 0) {
                            console.error('New manager not found');
                            return res.status(404).send({ error: 'New manager not found' });
                        }

                        const { start_date, days } = result[0];

                        // Update the department's manager_id
                        const updateDepartmentWithManagerQuery = `
                            UPDATE department
                            SET manager_id = ?
                            WHERE id = ?;
                        `;

                        db.query(updateDepartmentWithManagerQuery, [manager_id, departmentId], (err, result) => {
                            if (err) {
                                console.error('Error updating department with new manager ID:', err);
                                return res.status(500).send(err);
                            }

                            // Set leave days on promotion (if applicable)
                            setLeaveDaysOnPromotion(manager_id, promotionDate)
                                .then(() => {
                                    console.log(`Leave days updated successfully for new manager ID: ${manager_id}`);
                                    addLog(hrUserId, 'Promote Employee', `Promoted employee ID: ${manager_id} with updated leave days.`);
                                    res.send({ message: 'Department, manager, supervisor, branch manager, and first approval ID updated successfully' });
                                })
                                .catch(err => {
                                    console.error('Error updating leave days:', err);
                                    res.status(500).send(err);
                                });
                        });
                    });
                } else {
                    // Log the update
                    addLog(hrUserId, 'Update Department', `Updated department ID: ${departmentId}, set new first approval ID based on location.`);
                    res.send({ message: 'Department and first approval ID updated successfully' });
                }
        });
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
app.post('/login', async (req, res) => {
    const { email, password, isInitialLogin } = req.body;

    const userQuery = `SELECT * FROM employee WHERE email = ?`;
    db.query(userQuery, [email], async (err, result) => {
        if (err) {
            res.status(500).send(err);
        } else if (result.length === 0) {
            res.status(401).send({ message: 'Invalid email' });
        } else {
            const user = result[0];

            // Check if the user is a manager
            const isManagerQuery = `
                SELECT COUNT(*) AS is_manager FROM employee WHERE manager_id = ?
            `;
            db.query(isManagerQuery, [user.id], (err, managerResult) => {
                if (err) {
                    res.status(500).send(err);
                } else {
                    const isManager = managerResult[0].is_manager > 0;

                    // Check if the user is a first approver
                    const isFirstApproverQuery = `
                            SELECT COUNT(*) AS is_first_approver 
                            FROM (
                                SELECT id 
                                FROM department 
                                WHERE supervisor_id = ? AND id = ?
                                UNION
                                SELECT id 
                                FROM location 
                                WHERE branch_manager_id = ? AND id = ?
                            ) AS first_approver_check
                    `;
                    db.query(isFirstApproverQuery, [user.id, user.department_id, user.id, user.location_id], (err, firstApproverResult) => {
                        if (err) {
                            res.status(500).send(err);
                        } else {
                            const isFirstApprover = firstApproverResult[0].is_first_approver > 0;

                            if (isInitialLogin) {
                                bcrypt.hash(password, bcrypt.genSaltSync(12), (err, hashedPassword) => {
                                    if (err) res.send(err);
                                    db.query('UPDATE employee SET password = ? WHERE id = ?', [hashedPassword, user.id], (err, result) => {
                                        if (err) res.send(err);
                                        const token = jwt.sign(
                                            { id: user.id, is_hr: user.department_id == 4, is_manager: isManager, is_first_approver: isFirstApprover },
                                            jwt_secret,
                                            { expiresIn: '1h' }
                                        );
                                        res.send({ 
                                            message: 'Login successful', 
                                            token, 
                                            firstName: user.first_name, 
                                            lastName: user.last_name, 
                                            department: user.department_id,
                                            isHr: user.department_id == 4,
                                            isManager: isManager,
                                            isFirstApprover: isFirstApprover
                                        });
                                    });
                                });
                            } else {
                                bcrypt.compare(password, user.password, (err, isMatch) => {
                                    if (isMatch) {
                                        const token = jwt.sign(
                                            { id: user.id, is_hr: user.department_id == 4, is_manager: isManager, is_first_approver: isFirstApprover },
                                            jwt_secret,
                                            { expiresIn: '1h' }
                                        );
                                        res.send({ 
                                            message: 'Login successful', 
                                            token, 
                                            firstName: user.first_name, 
                                            lastName: user.last_name, 
                                            department: user.department_id,
                                            isHr: user.department_id == 4,
                                            isManager: isManager,
                                            isFirstApprover: isFirstApprover
                                        });
                                    } else {
                                        res.status(401).send({ message: 'Invalid email or password' });
                                    }
                                });
                            }
                        }
                    });
                }
            });
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
    const { name, manager_id, supervisor_id } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token

    const query = `
        INSERT INTO department (name, manager_id, supervisor_id)
        VALUES (?, ?, ?);
    `;
    db.query(query, [name, manager_id, supervisor_id], (err, result) => {
        if (err) {
            res.send(err);
        } else {
            const newDepartmentId = result.insertId;
            db.query(`SELECT * FROM department WHERE id = ?`, [newDepartmentId], (err, newDeptResult) => {
                if (err) {
                    res.send(err);
                } else {
                    addLog(hrUserId, 'Add Department', `Added department: ${name} with manager ID: ${manager_id}`);
                    res.send(newDeptResult[0]);
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

app.get('/managers-of-managers', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT e.id, e.first_name, e.last_name FROM employee e
            WHERE e.department_id = 13
        `;
        db.query(query, (err, result) => {
            if (err) res.send(err);
            else res.send(result);
        })
    } catch (error) {
        console.error('Error fetching managers of managers:', error);  // Log detailed error
        res.status(500).json({ message: 'Internal Server Error', error: error.message });  // Return detailed error
    }
});
app.post('/leave-requests', authenticateToken, (req, res) => {
    const { employeeId, typeOfLeave, quantity, leaveDetails } = req.body;
    console.log('Received leave request:', req.body);

    // Fetch holidays
    const holidayQuery = `
        SELECT start_date, end_date
        FROM holidays
    `;

    db.query(holidayQuery, (err, holidays) => {
        if (err) {
            console.error('Error fetching holidays:', err);
            return res.status(500).send(err);
        }

        // Check if any leaveDetails fall within the holidays
        const leaveDates = leaveDetails.map(detail => detail.date);
        const isHoliday = holidays.some(holiday => {
            const startDate = moment(holiday.start_date);
            const endDate = moment(holiday.end_date);
            return leaveDates.some(date => moment(date).isBetween(startDate, endDate, 'days', '[]'));
        });

        if (isHoliday) {
            return res.status(400).send({ message: 'Leave request cannot be made on holidays' });
        }

        // Handle special leave types: Sick Leave Without Note, Unpaid Leave
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

                determineInitialStatusAndInsert();
            });
        } else if (typeOfLeave === 'Unpaid Leave') {
            const checkUnpaidLeaveQuery = `
                SELECT SUM(quantity) as total
                FROM leave_requests
                WHERE employee_id = ? AND type_of_leave = 'Unpaid Leave' AND request_status != 'Cancelled'
            `;

            db.query(checkUnpaidLeaveQuery, [employeeId], (err, results) => {
                if (err) {
                    console.error('Database query error:', err);
                    return res.status(500).send(err);
                }

                const totalUnpaidLeaveDays = parseFloat(results[0].total) || 0;
                const requestQuantity = parseFloat(quantity);
                const totalRequested = totalUnpaidLeaveDays + requestQuantity;

                console.log("Total unpaid leave days:", totalUnpaidLeaveDays);
                console.log("Requested quantity:", requestQuantity);
                console.log("Total requested days:", totalRequested);

                if (totalRequested > 5) {
                    return res.status(400).send({ message: 'You cannot request more than 5 unpaid leave days.' });
                }

                determineInitialStatusAndInsert();
            });
        } else {
            determineInitialStatusAndInsert();
        }

        function determineInitialStatusAndInsert() {
            const firstApprovalQuery = `
                                        SELECT 
                                            CASE 
                                                WHEN l.location_name = 'Zalka' AND e.id != d.supervisor_id AND e.id != d.manager_id THEN d.supervisor_id
                                                WHEN l.location_name != 'Zalka' AND e.id != l.branch_manager_id THEN l.branch_manager_id
                                                ELSE NULL
                                            END AS first_approver_id
                                        FROM employee e
                                        LEFT JOIN department d ON e.department_id = d.id
                                        LEFT JOIN location l ON e.location_id = l.id
                                        WHERE e.id = ?;
            `;

            db.query(firstApprovalQuery, [employeeId], (err, results) => {
                if (err) {
                    console.error('Database query error:', err);
                    return res.status(500).send(err);
                }
                if (results.length > 0) {
                    const firstApprovalId = results[0].first_approver_id;
                    const initialStatus = firstApprovalId ? "Pending First Approval" : "Pending Manager";
            
                    insertLeaveRequest(initialStatus);
                } else {
                    console.error('No results returned for the employee ID:', employeeId);
                    return res.status(404).send('Employee not found');
                }
            });
        }

        function insertLeaveRequest(initialStatus) {
            // Calculate start date, end date, and quantity based on the leave type
            let startDate = leaveDetails.sort((a, b) => new Date(a.date) - new Date(b.date))[0].date;
            let endDate;
            let calculatedQuantity;

            if (typeOfLeave === 'Marital') {
                calculatedQuantity = 7.0;
                endDate = moment(startDate).add(6, 'days').format('YYYY-MM-DD');
            } else if (typeOfLeave === 'Maternity') {
                calculatedQuantity = 70.0;
                endDate = moment(startDate).add(69, 'days').format('YYYY-MM-DD');
            } else if (typeOfLeave === 'Paternity') {
                calculatedQuantity = 3.0;
                endDate = moment(startDate).add(2, 'days').format('YYYY-MM-DD');
            } else {
                calculatedQuantity = quantity;
                endDate = leaveDetails[leaveDetails.length - 1].date;
            }

            const query = `
                INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
                VALUES (?, ?, ?, ?, ?, ?, NOW())
            `;

            db.query(query, [employeeId, typeOfLeave, initialStatus, calculatedQuantity, startDate, endDate], (err, result) => {
                if (err) {
                    console.error('Error adding leave request:', err);
                    return res.status(500).send(err);
                }

                const leaveRequestId = result.insertId;
                let dateRange = [];

                if (typeOfLeave === 'Marital') {
                    dateRange = Array.from({ length: 7 }, (_, i) => moment(startDate).add(i, 'days').format('YYYY-MM-DD'));
                } else if (typeOfLeave === 'Maternity') {
                    dateRange = Array.from({ length: 70 }, (_, i) => moment(startDate).add(i, 'days').format('YYYY-MM-DD'));
                } else if (typeOfLeave === 'Paternity') {
                    dateRange = Array.from({ length: 3 }, (_, i) => moment(startDate).add(i, 'days').format('YYYY-MM-DD'));
                } else {
                    // For other types, use the dates provided in leaveDetails
                    dateRange = leaveDetails.map(detail => detail.date);
                }

                // Insert each date from the dateRange into the leave_request_dates table
                const dateQueries = dateRange.map(date => (
                    new Promise((resolve, reject) => {
                        const dateQuery = `
                            INSERT INTO leave_request_dates (leave_request_id, leave_date, duration, start_time, end_time, time)
                            VALUES (?, ?, ?, ?, ?, ?)
                        `;
                        const detail = leaveDetails.find(detail => detail.date === date) || {}; // Find matching detail or default to empty
                        const duration = detail.duration || '1.0'; // Default to full day if not specified
                        const time = detail.time || 'N/A';
                        const startTime = detail.start_time || null;
                        const endTime = detail.end_time || null;

                        db.query(dateQuery, [leaveRequestId, date, duration, startTime, endTime, time], (err, dateResult) => {
                            if (err) reject(err);
                            else resolve(dateResult);
                        });
                    })
                ));

                Promise.all(dateQueries)
                    .then(() => {
                        res.send({ message: `Leave request added successfully and ${initialStatus === 'Pending First Approval' ? 'awaiting first approval' : 'sent to manager'}` });
                    })
                    .catch(err => {
                        console.error('Error adding leave request dates:', err);
                        res.status(500).send(err);
                    });
            });
        }
    });
});
app.get('/first-approval-requests', authenticateToken, (req, res) => {
    const userId = req.user.id;

    const query = `
                    SELECT 
                        lr.id,
                        lr.employee_id AS employeeId, 
                        CONCAT(e.first_name, ' ', e.last_name) AS name,
                        lr.type_of_leave AS typeOfLeave, 
                        lr.request_status AS requestStatus, 
                        SUM(ld.duration) AS quantity,
                        CASE 
                            WHEN lr.type_of_leave IN ('Maternity', 'Paternity', 'Marital') 
                            THEN CONCAT(lr.start_date, ' >> ', lr.end_date)
                            ELSE GROUP_CONCAT(ld.leave_date)
                        END AS dates,
                        GROUP_CONCAT(
                            CASE 
                                WHEN lr.type_of_leave = 'Personal Time Off' THEN CONCAT(DATE_FORMAT(ld.start_time, '%H:%i'), ' >> ', DATE_FORMAT(ld.end_time, '%H:%i'))
                                WHEN ld.duration = 0.5 THEN ld.time
                                ELSE 'N/A'
                            END
                        ) AS time,
                        lr.last_modified AS lastModified 
                    FROM leave_requests lr
                    JOIN employee e ON lr.employee_id = e.id
                    LEFT JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
                    LEFT JOIN department d ON e.department_id = d.id
                    LEFT JOIN location l ON e.location_id = l.id
                    WHERE lr.request_status = 'Pending First Approval'
                    AND (
                        d.supervisor_id = ? 
                        OR l.branch_manager_id = ?
                    )
                    GROUP BY lr.id
                    ORDER BY lastModified DESC;

    `;
    db.query(query, [userId, userId], (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});
app.get('/first-approver-leaves', authenticateToken, (req, res) => {
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
                    LEFT JOIN department d ON e.department_id = d.id
                    LEFT JOIN location l ON e.location_id = l.id
                    WHERE lr.request_status IN ('Approved', 'Pending First Approval', 'Pending Manager')
                    AND (
                        d.supervisor_id = ? 
                        OR l.branch_manager_id = ?
                    );
    `;
    db.query(query, [userId, userId], (err, result) => {
        if (err) res.status(500).send(err);
        else res.send(result);
    });
});

app.patch('/leave-requests/:id/first-approve', authenticateToken, (req, res) => {
    const requestId = req.params.id;
    const action = req.body.action; // 'approve' or 'reject'

    let newStatus;
    if (action === 'approve') {
        newStatus = 'Pending Manager';
    } else if (action === 'reject') {
        newStatus = 'Rejected';
    } else {
        return res.status(400).send({ message: 'Invalid action' });
    }

    const query = `
        UPDATE leave_requests
        SET request_status = ?, last_modified = NOW()
        WHERE id = ? AND request_status = 'Pending First Approval'
    `;

    db.query(query, [newStatus, requestId], (err, result) => {
        if (err) {
            console.error('Error updating leave request:', err);
            return res.status(500).send(err);
        }
        res.send({ message: `Leave request ${action}ed` });
    });
});


app.get('/previous-unpaid-leave-days/:employeeId', authenticateToken, (req, res) => {
    const employeeId = req.params.employeeId;

    const query = `
        SELECT SUM(quantity) as total
        FROM leave_requests
        WHERE employee_id = ? AND type_of_leave = 'Unpaid Leave' AND request_status != 'Cancelled'
    `;

    db.query(query, [employeeId], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            return res.status(500).send(err);
        }
        const totalUnpaidLeaveDays = results[0].total || 0;
        res.send({ total: totalUnpaidLeaveDays });
    });
});


app.patch('/holidays/:id', hrAuthenticateToken, async (req, res) => {
    const id = req.params.id;
    const { startDate, endDate, description } = req.body;
    const hrUserId = getIdFromToken(req);  // Get HR user ID from token
    const formattedStartDate = moment(startDate).format('YYYY-MM-DD');
    const formattedEndDate = moment(endDate).format('YYYY-MM-DD');

    const updateHolidayQuery = `
        UPDATE holidays
        SET start_date = ?, end_date = ?, description = ?
        WHERE id = ?
    `;

    db.query(updateHolidayQuery, [formattedStartDate, formattedEndDate, description, id], (err, result) => {
        if (err) {
            console.error('Error updating holiday:', err);
            return res.status(500).send(err);
        }

        addLog(hrUserId, 'Edit Holiday', `Edited holiday ${id}: ${formattedStartDate} to ${formattedEndDate}, description: ${description}`);

        const findLeaveRequestsQuery = `
            SELECT lr.id, lr.employee_id, lr.type_of_leave, lr.quantity, lrd.duration, lrd.leave_date, lr.request_status
            FROM leave_requests lr
            JOIN leave_request_dates lrd ON lr.id = lrd.leave_request_id
            WHERE lrd.leave_date BETWEEN ? AND ?
            AND lr.request_status IN ('Approved', 'Pending Manager', 'Pending First Approval', 'Cancel Requested')
        `;

        db.query(findLeaveRequestsQuery, [formattedStartDate, formattedEndDate], (err, leaveRequests) => {
            if (err) {
                console.error('Error finding leave requests:', err);
                return res.status(500).send(err);
            }

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
                .then(() => res.send({ message: 'Holiday updated and overlapping leave requests cancelled successfully' }))
                .catch(err => {
                    console.error('Error updating leave requests:', err);
                    res.status(500).send(err);
                });
        });
    });
});



const addLog = (hrUserId, action, details) => {
    const getUserInfoQuery = 'SELECT first_name, last_name FROM employee WHERE id = ?';
    db.query(getUserInfoQuery, [hrUserId], (err, results) => {
        if (err) {
            console.error('Error fetching HR user info:', err);
            return;
        }
        
        if (results.length > 0) {
            const hrUser = results[0];
            const hrUserName = `${hrUser.first_name} ${hrUser.last_name}`;

            const insertLogQuery = `
                INSERT INTO logs (hr_user, hr_user_name, action, details)
                VALUES (?, ?, ?, ?)
            `;
            
            db.query(insertLogQuery, [hrUserId, hrUserName, action, details], (err, result) => {
                if (err) console.error('Error logging action:', err);
            });
        } else {
            console.log('HR user not found');
        }
    });
};




app.get('/logs', (req, res) => {
    const query = `
        SELECT l.id, l.hr_user_name as "hr_user_name", l.action, l.details, l.timestamp
        FROM logs l
        ORDER BY l.timestamp DESC
    `;
    db.query(query, (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});
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
                        CASE 
                            WHEN lr.type_of_leave IN ('Maternity', 'Paternity', 'Marital') 
                            THEN CONCAT(lr.start_date, ' >> ', lr.end_date)
                            ELSE GROUP_CONCAT(ld.leave_date)
                        END AS dates,
                        GROUP_CONCAT(
                            CASE 
                                WHEN lr.type_of_leave = 'Personal Time Off' THEN CONCAT(DATE_FORMAT(ld.start_time, '%H:%i'), ' >> ', DATE_FORMAT(ld.end_time, '%H:%i'))
                                WHEN ld.duration = 0.5 THEN ld.time
                                ELSE 'N/A'
                            END
                        ) AS time,
                        lr.last_modified AS lastModified 
                    FROM leave_requests lr
                    JOIN employee e ON lr.employee_id = e.id
                    LEFT JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
                    JOIN employee m ON e.manager_id = m.id
                    WHERE m.id = ?
                    AND lr.request_status IN ('Approved', 'Pending Manager', 'HR Remove', 'Cancel Requested')
                    GROUP BY lr.id
                    ORDER BY lastModified DESC
    `;
    db.query(query, [userId], (err, result) => {
        if (err) res.send(err);
        else res.send(result);
    });
});
app.post('/leave-requests/hr', authenticateToken, (req, res) => {
    const { employeeId, action, reason, leaveDetails } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token

    let totalAmount = 0;
    leaveDetails.forEach(detail => {
        const { duration } = detail;
        totalAmount += Number(duration);
    });

    const typeOfLeave = reason;
    const requestStatus = action === 'Add' ? 'HR Add' : 'HR Remove';

    const startDate = leaveDetails[0].date;
    const endDate = leaveDetails[leaveDetails.length - 1].date;

    const employeeQuery = `SELECT first_name, last_name FROM employee WHERE id = ?`;

    db.query(employeeQuery, [employeeId], (err, employeeResult) => {
        if (err) {
            console.error('Error fetching employee details:', err);
            return res.status(500).send(err);
        }

        if (employeeResult.length === 0) {
            return res.status(404).send({ message: 'Employee not found' });
        }

        const employeeName = `${employeeResult[0].first_name} ${employeeResult[0].last_name}`;

        const query = `
            INSERT INTO leave_requests (employee_id, type_of_leave, request_status, quantity, start_date, end_date, last_modified)
            VALUES (?, ?, ?, ?, ?, ?, NOW())
        `;

        db.query(query, [employeeId, typeOfLeave, requestStatus, totalAmount, startDate, endDate], (err, result) => {
            if (err) {
                console.error('Error adding leave request:', err);
                return res.status(500).send(err);
            }

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
                            return res.status(500).send(err);
                        } else {
                            const logAction = action === 'Add' ? 'Add Days' : 'Remove Days';
                            addLog(hrUserId, logAction, `${logAction} for employee: ${employeeName}, Amount: ${totalAmount}`);
                            res.send({ message: 'Leave request added successfully and days updated' });
                        }
                    });
                })
                .catch(err => {
                    console.error('Error adding leave request dates:', err);
                    res.status(500).send(err);
                });
        });
    });
});
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
            lr.quantity,
            CASE 
                WHEN lr.type_of_leave IN ('Maternity', 'Paternity', 'Marital') 
                THEN CONCAT(lr.start_date, ' >> ', lr.end_date)
                ELSE GROUP_CONCAT(ld.leave_date)
            END AS dates, -- Conditionally formatted dates field
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
        WHERE lr.id = ? AND (lr.request_status = 'Pending Manager' OR lr.request_status = 'Approved' OR lr.request_status = 'Pending First Approval')
    `;
    db.query(fetchQuery, [id], (err, result) => {
        if (err) {
            console.error('Error fetching leave request:', err);
            res.status(500).send(err);
        } else if (result.length === 0) {
            res.status(404).send({ message: 'Leave request not found or already processed' });
        } else {
            const { request_status } = result[0];
            let updateRequestQuery;

            if (request_status === 'Pending First Approval' || request_status === 'Pending Manager') {
                updateRequestQuery = `
                    UPDATE leave_requests 
                    SET request_status = 'Cancelled', last_modified = NOW() 
                    WHERE id = ? AND (request_status = 'Pending First Approval' || request_status = 'Pending Manager')
                `;
            } else if (request_status === 'Approved') {
                updateRequestQuery = `
                    UPDATE leave_requests 
                    SET request_status = 'Cancel Requested', last_modified = NOW() 
                    WHERE id = ? AND request_status = ?
                `;
            }

            db.query(updateRequestQuery, [id, request_status], (err, updateResult) => {
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
                    if (!['Sick Leave With Note', 'Sick Leave Without Note', 'Personal Time Off', 'Condolences', 'Marital', 'Paternity', 'Maternity'].includes(type_of_leave)) {
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

app.get('/holidays', (req, res) => {
    const query = `
        SELECT *
        FROM holidays
    `;
    db.query(query, (err, result) => {
        if (err) {
            console.error('Error fetching holidays:', err);
            res.status(500).send(err);
        } else {
            res.send(result);
        }
    });
});

app.get('/unavailable-dates/:id', authenticateToken, (req, res) => {
    const id = req.params.id;
    const query = `
SELECT 
            CASE 
                WHEN main.duration >= 1 THEN 'NONE'
                WHEN main.duration = 0.5 AND main.time = 'AM' THEN 'HD-AM'
                WHEN main.duration = 0.5 AND main.time = 'PM' THEN 'HD-PM'
                WHEN main.start_time IS NOT NULL AND main.end_time IS NOT NULL AND TIMESTAMPDIFF(MINUTE, main.start_time, main.end_time) > 0 THEN 'PTO'
                ELSE 'N/A'
            END AS action,
            main.leave_date as date
        FROM (
            SELECT  
                ld.duration,
                ld.leave_date,
                ld.time,
                ld.start_time,
                ld.end_time
            FROM leave_requests lr
            JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
            WHERE lr.employee_id = ?
              AND (lr.request_status != 'Cancelled' && lr.request_status != 'Rejected')
        ) main
    `;

    db.query(query, [id], (err, results) => {
        if (err) {
            console.error('Error fetching unavailable dates:', err);
            res.send(err);
        } else {
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
WHERE e.manager_id = ? 
AND lr.request_status IN ('Approved', 'Pending Manager')
    `;
    db.query(query, [userId], (err, result) => {
        if (err) res.status(500).send(err);
        else res.send(result);
    });
});
app.post('/holiday', hrAuthenticateToken, async (req, res) => {
    const { startDate, endDate, description } = req.body;
    const hrUserId = getIdFromToken(req); // Get HR user ID from token
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
        
        addLog(hrUserId, 'Add Holiday', `Added holiday from ${formattedStartDate} to ${formattedEndDate} with description: ${description}`);

        const findLeaveRequestsQuery = `
            SELECT lr.id, lr.employee_id, lr.type_of_leave, lr.quantity, lrd.duration, lrd.leave_date, lr.request_status
            FROM leave_requests lr
            JOIN leave_request_dates lrd ON lr.id = lrd.leave_request_id
            WHERE lrd.leave_date BETWEEN ? AND ?
            AND lr.request_status IN ('Approved', 'Pending Manager', 'Pending First Approval', 'Cancel Requested')
        `;

        db.query(findLeaveRequestsQuery, [formattedStartDate, formattedEndDate], (err, leaveRequests) => {
            if (err) {
                console.error('Error finding leave requests:', err);
                return res.status(500).send(err);
            }

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
            ld.start_time,
            ld.end_time,
            ld.duration,
            ld.time
        FROM leave_requests lr
        JOIN leave_request_dates ld ON lr.id = ld.leave_request_id
        JOIN employee e ON lr.employee_id = e.id
        WHERE lr.request_status IN ('Approved', 'Pending Manager', 'Pending First Approval') 
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

    console.log(`Fetching remaining time off for employeeId: ${employeeId}, Month: ${currentMonth}, Year: ${currentYear}`);

    const checkPTOQuery = `
        SELECT SUM(TIMESTAMPDIFF(MINUTE, start_time, end_time)) as totalMinutes
        FROM leave_request_dates
        JOIN leave_requests ON leave_request_dates.leave_request_id = leave_requests.id
        WHERE leave_requests.employee_id = ? 
        AND leave_requests.type_of_leave = 'Personal Time Off'
        AND MONTH(leave_request_dates.leave_date) = ? 
        AND YEAR(leave_request_dates.leave_date) = ?
        AND leave_requests.request_status != 'Cancelled'
    `;

    db.query(checkPTOQuery, [employeeId, currentMonth, currentYear], (err, results) => {
        if (err) {
            console.error('Database query error:', err);
            return res.status(500).send(err);
        }

        console.log('Query results:', results);

        const totalMinutesTaken = parseFloat(results[0].totalMinutes) || 0;
        console.log(`Total minutes taken: ${totalMinutesTaken}`);

        const remainingMinutes = Math.max(0, 120 - totalMinutesTaken);
        console.log(`Remaining minutes: ${remainingMinutes}`);

        res.send({ remainingMinutes });
    });
});

app.get('/location', hrAuthenticateToken, (req, res) => {
    const dbQuery = `
        SELECT *
        FROM location;
    `;

    db.query(dbQuery, (err, results) => {
        if (err) return res.status(500).send(err);
        else res.send(results);
    });
});

app.post('/location', hrAuthenticateToken, (req, res) => {
    const { location_name, branch_manager_id } = req.body;
    console.log("jnjdnckndwocnwdon: "+location_name+"    "+branch_manager_id)
    const dbQuery = `
        INSERT INTO location
        (location_name, branch_manager_id) VALUES (?,?);
    `;

    db.query(dbQuery, [location_name, branch_manager_id], (err, results) => {
        if (err) return res.status(500).send(err);
        else{
            res.send({
                location_name,
                branch_manager_id
            });
        }
    });
});
app.patch('/locations/:id', hrAuthenticateToken, (req, res) => {
    const locationId = req.params.id;
    const { location_name, branch_manager_id } = req.body;

    const updateQuery = `
        UPDATE location 
        SET location_name = ?, branch_manager_id = ? 
        WHERE id = ?;
    `;

    db.query(updateQuery, [location_name, branch_manager_id, locationId], (err, result) => {
        if (err) {
            console.error('Database update error:', err);
            return res.status(500).send('An error occurred while updating the location.');
        }

        if (result.affectedRows === 0) {
            return res.status(404).send('Location not found.');
        }

        res.send({ 
            id: locationId, 
            location_name, 
            branch_manager_id 
        });
    });
});

cron.schedule('0 0 30 6 *', () => {
    console.log('Running June 30th leave deduction check...');

    // Fetch all employees
    const getEmployeesQuery = `
        SELECT id, start_date, days
        FROM employee
    `;

    db.query(getEmployeesQuery, (err, employees) => {
        if (err) {
            console.error('Error fetching employees:', err);
            return;
        }

        employees.forEach(employee => {
            const { id, start_date, days } = employee;
            const startMoment = moment(start_date);
            const currentMoment = moment();
            const yearsOfService = currentMoment.diff(startMoment, 'years');

            // Calculate leave days per year based on service years and manager status
            let leaveDaysPerYear = 15;
            isManager(id).then(isManagerStatus => {
                if (isManagerStatus) {
                    leaveDaysPerYear = 21;
                } else if (yearsOfService >= 15) {
                    leaveDaysPerYear = 21;
                } else if (yearsOfService >= 5) {
                    leaveDaysPerYear = 18;
                }

                const daysToBeConsumed = days - (leaveDaysPerYear * 2);
                if (daysToBeConsumed > 0) {
                    const updatedDays = days - daysToBeConsumed;

                    // Update the employee's days
                    const updateDaysQuery = `UPDATE employee SET days = ? WHERE id = ?`;
                    db.query(updateDaysQuery, [updatedDays, id], (updateErr) => {
                        if (updateErr) {
                            console.error(`Error updating days for employee ID ${id}:`, updateErr);
                        } else {
                            console.log(`Updated days for employee ID ${id}: ${updatedDays}`);
                        }
                    });
                }
            }).catch(err => {
                console.error('Error checking if employee is a manager:', err);
            });
        });
    });
});
app.post('/api/update-leave-days', (req, res) => {
    updateLeaveDaysOnJan1()
        .then(() => {
            res.status(200).send('Leave days update triggered successfully');
        })
        .catch(err => {
            console.error('Error triggering leave days update:', err);
            res.status(500).send('An error occurred while triggering the leave days update');
        });
});