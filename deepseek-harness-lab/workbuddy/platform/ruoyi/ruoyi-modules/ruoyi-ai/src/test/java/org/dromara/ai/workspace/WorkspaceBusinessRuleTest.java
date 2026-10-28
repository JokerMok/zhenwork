package org.dromara.ai.workspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Tag;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

@Tag("dev")
class WorkspaceBusinessRuleTest {
    private Map<String,Object> rule() {
        var rule=new LinkedHashMap<String,Object>();
        rule.put("kind","WASTE_MONTHLY");rule.put("meaning","Sum verified production records by business date");rule.put("scope","Authorized input files only");
        rule.put("grain","business_record_id");rule.put("timeField","business_date");rule.put("period","calendar_month_Asia_Shanghai");
        rule.put("duplicateRule","identical_first");rule.put("precision",3);rule.put("unitFactors",Map.of("kg","1","吨","1000"));
        rule.put("includeNodes",List.of("产生"));rule.put("nodeAliases",Map.of("产生","产生","入库","入库"));rule.put("sourceAliases",Map.of("A","A"));rule.put("categoryAliases",Map.of("HW08","HW08"));
        rule.put("organizationAliases",Map.of());rule.put("allowedOrganizations",List.of());rule.put("statusAliases",Map.of("撤销","cancelled"));
        rule.put("summaryRows","exclude_with_warning");rule.put("reversal","block");rule.put("negative","block");return rule;
    }
    @Test void formalRuleUsesExistingVersionedToolConfiguration() {
        var input=Map.<String,Object>of("toolType","CALCULATOR","businessRule",rule());
        assertEquals(rule(),WorkspaceToolAccess.configuration(input).get("businessRule"));
        assertEquals(Map.of("toolType","CALCULATOR","precision",4),WorkspaceToolAccess.configuration(Map.of("toolType","CALCULATOR")));
    }
    @Test void cannotInjectCodeOrUnmappedFiltersOrUnverifiedPolicies() {
        for(var change:List.of(Map.<String,Object>of("sql","select *"),Map.<String,Object>of("includeNodes",List.of("unknown")),Map.<String,Object>of("precision",1.5),Map.<String,Object>of("reversal","ignore"),Map.<String,Object>of("unitFactors",Map.of("kg","-1")))) {
            var value=rule();value.putAll(change);
            assertThrows(WorkspaceDenied.class,()->WorkspaceToolAccess.configuration(Map.of("toolType","CALCULATOR","businessRule",value)));
        }
        assertThrows(WorkspaceDenied.class,()->WorkspaceToolAccess.configuration(Map.of("toolType","TEXT_DOCUMENT","businessRule",rule())));
    }
}
