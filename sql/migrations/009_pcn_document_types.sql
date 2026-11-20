-- TA/SC codes use independent Bangkok-calendar issue dates. No existing PCN is renumbered.
IF OBJECT_ID(N'pcn.PcnDailyCounters', N'U') IS NULL
CREATE TABLE pcn.PcnDailyCounters (
  DocumentType varchar(2) NOT NULL,
  IssueDate date NOT NULL,
  LastSequence int NOT NULL,
  CONSTRAINT PK_PcnDailyCounters PRIMARY KEY (DocumentType,IssueDate),
  CONSTRAINT CK_PcnDailyCounters_Type CHECK (DocumentType IN ('ta','sc')),
  CONSTRAINT CK_PcnDailyCounters_Sequence CHECK (LastSequence BETWEEN 0 AND 99)
);

-- Expand the signing-department constraint without assigning any account to the new teams.
IF OBJECT_ID(N'pcn.CK_Users_SigningDepartment', N'C') IS NOT NULL
ALTER TABLE pcn.Users DROP CONSTRAINT CK_Users_SigningDepartment;
ALTER TABLE pcn.Users WITH CHECK ADD CONSTRAINT CK_Users_SigningDepartment
  CHECK (SigningStep IS NULL OR (DepartmentKey IS NOT NULL AND DepartmentKey IN
    (N'gscTet',N'prodEngTet',N'prodEngTa',N'prodEngSc',N'qaTet',N'gscTapbu',N'qaTapbu')));
