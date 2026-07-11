import { describe, expect, it } from "vitest";

import {
  detectMainframeLanguage,
  parseCobol,
  parseMainframeSource,
  parsePli,
  parseRexx,
} from "../../src/parser";

describe("embedded SQL and CICS parsing", () => {
  it("extracts SQL tables, columns, joins, predicates, and host variables from COBOL", () => {
    const result = parseCobol(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. SQL-DEEP.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-ID PIC 9(9).
       01 WS-NAME PIC X(20).
       PROCEDURE DIVISION.
       MAIN-PARA.
           EXEC SQL
             SELECT C.CUST_ID, A.ACCOUNT_BALANCE
               INTO :WS-ID, :WS-NAME
               FROM CUSTOMER_MASTER C
               INNER JOIN ACCOUNT_MASTER A
                 ON C.CUST_ID = A.CUST_ID
              WHERE C.STATUS = 'ACTIVE'
           END-EXEC.
           EXEC SQL
             UPDATE ACCOUNT_MASTER
                SET ACCOUNT_BALANCE = :WS-ID
              WHERE CUST_ID = :WS-ID
           END-EXEC.
           STOP RUN.
    `);

    const tables = result.graph.nodes
      .filter((node) => node.type === "TABLE")
      .map((node) => node.id)
      .sort();

    expect(tables).toEqual(["ACCOUNT_MASTER", "CUSTOMER_MASTER"]);
    expect(result.graph.edges.some((edge) => edge.type === "DATA_ACCESS" && edge.target === "ACCOUNT_MASTER")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "READS" && edge.target === "CUSTOMER_MASTER")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "MODIFIES" && edge.target === "ACCOUNT_MASTER")).toBe(true);
    expect(result.dataAccess.some((node) => node.description.includes("ACCOUNT_BALANCE"))).toBe(true);
  });

  it("extracts cursor SQL and CICS program/file/map targets", () => {
    const result = parseCobol(`
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CICS-DEEP.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-ID PIC 9(9).
       PROCEDURE DIVISION.
       MAIN-PARA.
           EXEC SQL
             DECLARE C1 CURSOR FOR
             SELECT ORDER_ID FROM ORDER_TABLE WHERE STATUS = 'OPEN'
           END-EXEC.
           EXEC CICS LINK PROGRAM('AUTHSVC') COMMAREA(WS-ID) END-EXEC.
           EXEC CICS READ FILE('CUSTFILE') INTO(WS-ID) END-EXEC.
           EXEC CICS SEND MAP('PAYMAP') MAPSET('PAYSET') END-EXEC.
           STOP RUN.
    `);

    expect(result.graph.nodes.some((node) => node.type === "TABLE" && node.id === "ORDER_TABLE")).toBe(true);
    expect(result.graph.nodes.some((node) => node.type === "PROGRAM" && node.id === "AUTHSVC")).toBe(true);
    expect(result.graph.nodes.some((node) => node.type === "FILE" && node.id === "CUSTFILE")).toBe(true);
    expect(result.graph.nodes.some((node) => node.type === "MAP" && node.id === "PAYMAP")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "EXTERNAL_CALL" && edge.target === "AUTHSVC")).toBe(true);
    expect(result.graph.edges.some((edge) => edge.type === "READS" && edge.target === "CUSTFILE")).toBe(true);
  });
});

describe("PL/I and REXX parser registry", () => {
  it("parses PL/I procedures, declarations, calls, branches, and embedded SQL", () => {
    const result = parsePli(`
PAYPROC: PROC OPTIONS(MAIN);
  DCL ACCOUNT_ID CHAR(10), BALANCE FIXED DEC(15,2);
  EXEC SQL SELECT ACCOUNT_BALANCE INTO :BALANCE FROM ACCOUNT_MASTER WHERE ACCOUNT_ID = :ACCOUNT_ID;
  IF BALANCE < 0 THEN CALL ALERT_NEGATIVE(ACCOUNT_ID);
  SELECT;
    WHEN (BALANCE = 0) CALL ZERO_BALANCE(ACCOUNT_ID);
    OTHERWISE CALL NORMAL_BALANCE(ACCOUNT_ID);
  END;
END PAYPROC;
`, { filename: "payproc.pli" });

    expect(result.language).toBe("pli");
    expect(result.programName).toBe("PAYPROC");
    expect(result.dataAccess.some((node) => node.description.includes("ACCOUNT_MASTER"))).toBe(true);
    expect(result.externalCalls.some((node) => node.description.toUpperCase().includes("ALERT NEGATIVE"))).toBe(true);
    expect(result.controlFlow.length).toBeGreaterThanOrEqual(1);
    expect(result.graph.edges.some((edge) => edge.type === "DATA_ACCESS" && edge.target === "ACCOUNT_MASTER")).toBe(true);
  });

  it("parses REXX automation scripts and external calls", () => {
    const result = parseRexx(`
/* REXX PAYCHECK */
parse arg accountId
say 'Checking account' accountId
if accountId = '' then say 'Missing account'
call PAYAUDIT accountId
do i = 1 to 3
  say i
end
`, { filename: "paycheck.rexx" });

    expect(result.language).toBe("rexx");
    expect(result.programName).toBe("PAYCHECK");
    expect(result.externalCalls.some((node) => node.description.includes("PAYAUDIT"))).toBe(true);
    expect(result.controlFlow.length).toBeGreaterThanOrEqual(2);
    expect(result.graph.edges.some((edge) => edge.type === "EXTERNAL_CALL" && edge.target === "PAYAUDIT")).toBe(true);
  });

  it("auto-detects mainframe languages from filename or content", () => {
    expect(detectMainframeLanguage("SAY 'hello'", { filename: "hello.rexx" })).toBe("rexx");
    expect(detectMainframeLanguage("PAY: PROC; DCL X FIXED; END PAY;")).toBe("pli");

    const result = parseMainframeSource("//JOB1 JOB (ACCT),'X'\n//S1 EXEC PGM=PAYROLL", {
      filename: "PAYJOB.JCL",
    });
    expect(result.language).toBe("jcl");
  });
});
