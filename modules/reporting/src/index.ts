/**
 * @aytracker/module-reporting — server-side aggregation.
 *
 * Subscribes to domain events from other modules; imports none of them. Reports read from
 * dedicated query repositories rather than reaching into another module's tables.
 */

export {
  aggregateAttendance,
  totalAttendance,
  type AttendanceRow,
  type AttendanceTotals,
  type ShiftFact,
} from './domain/attendance.js';
