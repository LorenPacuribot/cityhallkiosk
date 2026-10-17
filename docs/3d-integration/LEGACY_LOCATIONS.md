# Historical office location reference

Extracted from the user-supplied `cityadmin (1).sql`. Only office names, location relationships, and coordinates are retained; account, session, and service records are excluded.

- Office/location records date from 2024-05-01. They do not contain the r09 model doorway IDs.
- Coordinates are in an unknown legacy model frame: x approximately -10..10, y 0..0.951. Current model is approximately 118 m wide with the second floor at 4 m.
- Zero coordinates are missing-position placeholders. Room 6 is labeled floor 1 but has the same legacy y as most floor-2 rooms.
- The office_location_pivots table omits office 8 (Economic Enterprise); offices.location_id links it to location 18.
- No current database records, calibration, or doorway mappings have been overwritten.

| Office | Legacy location | Floor | Legacy x / y / z |
|---|---|---|---|
| City Accounting Office | Room 15 | 2 | 8.389 / 0.951 / -0.473 |
| City Administrator Office | Room 10 | 2 | -4.615 / 0.951 / -0.102 |
| City Agriculture Office | San Isidro St., Barangay 8, Malaybalay City | Not located at City Hall | 0 / 0 / 0 |
| City Assessor Office | Room 3 | 1 | 7.43 / 0.08 / 2.8816 |
| City Budget Office | Room 13 | 2 | 7.642 / 0.951 / 0.899 |
| City Civil Registrar | Room 4 | 1 | 10.439 / 0.08 / -0.039 |
| City Disaster Risk Reduction and Management Office | Room 18 | 2 | 0 / 0 / 0 |
| City Economic Enterprise Development and Management Office | Room 18 | 2 | 0 / 0 / 0 |
| City Engineer’s Office | San Isidro St., Barangay 8, Malaybalay City | Not located at City Hall | 0 / 0 / 0 |
| City Environment and Natural Resources Office | Room 1 | 1 | -9.106 / 0.08 / 0.122 |
| City General Services Office | Room 6 | 1 | -7.525 / 0.951 / 2.865 |
| City Health Office | Murillo St., Barangay 8, Malaybalay City | Not located at City Hall | 0 / 0 / 0 |
| City Human Resources Management Office | Room 12 | 2 | 7.674 / 0.951 / 2.788 |
| City Legal Office | Room 17 | 2 | -9.622 / 0.951 / -0.417 |
| City Mayors Office | Room 11 | 2 | 0.769 / 0.951 / 0.013 |
| Bids and Awards Committee | Room 9 | 2 | -8.438 / 0.08 / -0.62 |
| Business Permit and Licensing Division | Room 8 | 1 | 9.678 / 0.08 / -0.764 |
| City Urban Development and Housing Division | Room 5 | 1 | -9.461 / 0.08 / -0.62 |
| Public Employment Service Office | Room 11 | 2 | 0.769 / 0.951 / 0.013 |
| Office of the Senior Citizen Affairs | Room 11 | 2 | 0.769 / 0.951 / 0.013 |
| Office of Building Official | Room 14 | 2 | 0 / 0 / 0 |
| City Planning and Development Office | Room 16 | 2 | -5.167 / 0.951 / 0.417 |
| City Social Welfare and Development Office | Room 2 | 1 | -6.669 / 0.08 / 0.122 |
| City Treasurer’s Office | Room 7 | 1 | 5.214 / 0.08 / -0.742 |
| City Veterinary Office | San Isidro St., Barangay 8, Malaybalay City | Not located at City Hall | 0 / 0 / 0 |
| City Vice Mayors Office | Room 14 | 2 | 0 / 0 / 0 |
| Acer/ 117 | Room 19 | 2 | 0 / 0 / 0 |
| City Tourism Office | Room 20 | 2 | 0 / 0 / 0 |
| Sangguniang Panlungsod | Market Side, Barangay 9, Malaybalay City | Not located at City Hall | 0 / 0 / 0 |

To map the four pilot doors, the missing link is a labeled plan or the old model that shows where these numbered rooms sit relative to the current doorways. Numeric proximity across the two coordinate systems is not a reliable correspondence.
